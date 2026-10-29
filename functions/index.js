// functions/index.js - Versi Final SaaS Multi-Environment (Lokal & Live Cloud)
const { onRequest } = require("firebase-functions/v2/https");
const express = require('express');
const { exec } = require('child_process');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(express.json());

// Jaring Pengaman CORS produksi murni
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Pemilih Token Pintar: gcloud untuk Lokal Emulator, GoogleAuth Service untuk Cloud Server
const dapatkanTokenAkses = async () => {
    // Jika berjalan di server Google Cloud Run asli
    if (process.env.FUNCTIONS_EMULATOR !== "true") {
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });
        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        return tokenResponse.token;
    }
    
    // Jika berjalan di laptop lokal (Emulator)
    return new Promise((resolve, reject) => {
        exec('gcloud auth print-access-token', (err, stdout) => {
            if (err) reject("Gcloud desktop CLI token generation failed.");
            else resolve(stdout.trim());
        });
    });
};

// ====================================================================
// GITLAB EXECUTORS ENGINE
// ====================================================================

async function eksekusiBuatRepo(namaRepo, visibilitas, tokenGitLab) {
    const res = await fetch('https://gitlab.com/api/v4/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': tokenGitLab },
        body: JSON.stringify({ 
            name: namaRepo, 
            visibility: visibilitas || 'private', 
            initialize_with_readme: true 
        })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "GitLab API rejected repo creation.");
    return { urlWeb: data.web_url, idProyek: data.id, visibilitasTerpilih: visibilitas || 'private' };
}

async function eksekusiHapusRepo(namaRepo, tokenGitLab) {
    const searchRes = await fetch(`https://gitlab.com/api/v4/projects?search=${namaRepo}`, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': tokenGitLab }
    });
    const proyekList = await searchRes.json();
    if (!proyekList || proyekList.length === 0) throw new Error("Repository not found in this GitLab account.");

    const idProyek = proyekList[0].id;
    const namaBaruAcak = `${namaRepo}-old-${Date.now()}`;

    await fetch(`https://gitlab.com/api/v4/projects/${idProyek}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': tokenGitLab },
        body: JSON.stringify({ name: namaBaruAcak, path: namaBaruAcak })
    });

    await fetch(`https://gitlab.com/api/v4/projects/${idProyek}`, {
        method: 'DELETE',
        headers: { 'PRIVATE-TOKEN': tokenGitLab }
    });

    return { status: "Successfully scheduled deletion", idProyek };
}

async function eksekusiTambahFiturMR(namaRepo, namaFile, isiKode, tokenGitLab) {
    const searchRes = await fetch(`https://gitlab.com/api/v4/projects?search=${namaRepo}`, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': tokenGitLab }
    });
    const proyekList = await searchRes.json();
    if (!proyekList || proyekList.length === 0) throw new Error(`Repository [${namaRepo}] not found.`);
    const idProyek = proyekList[0].id;

    const namaBranch = `ai-feature-${Date.now()}`;

    const branchRes = await fetch(`https://gitlab.com/api/v4/projects/${idProyek}/repository/branches?branch=${namaBranch}&ref=main`, {
        method: 'POST',
        headers: { 'PRIVATE-TOKEN': tokenGitLab }
    });
    if (!branchRes.ok) throw new Error("Branch creation rejected by GitLab.");

    const commitPayload = {
        branch: namaBranch,
        commit_message: `AI Updated: Added ${namaFile}`,
        actions: [{ action: "create", file_path: namaFile, content: isiKode }]
    };
    
    const commitRes = await fetch(`https://gitlab.com/api/v4/projects/${idProyek}/repository/commits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': tokenGitLab },
        body: JSON.stringify(commitPayload)
    });
    if (!commitRes.ok) throw new Error("Code commit rejected.");

    const mrRes = await fetch(`https://gitlab.com/api/v4/projects/${idProyek}/merge_requests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PRIVATE-TOKEN': tokenGitLab },
        body: JSON.stringify({
            source_branch: namaBranch,
            target_branch: "main",
            title: `🚀 AI Update: Integrated feature file [${namaFile}]`,
            description: `### 🤖 Git DevOps Agent Report\nAutomated functional logic applied.`
        })
    });
    
    const mrData = await mrRes.json();
    if (!mrRes.ok) throw new Error("Merge Request opening failed.");
    
    return { status: "Merge Request Opened Successfully", urlPersetujuan: mrData.web_url };
}

// ====================================================================
// GATEWAY ROURTING ENDPOINTS
// ====================================================================

app.post('/chat', async (req, res) => {
    const { pesanUser, tokenUserGitLab } = req.body;
    if (!pesanUser) return res.status(400).json({ error: "Instruction message cannot be empty." });

    try {
        // Deteksi Project ID otomatis baik di server cloud maupun lokal emulator
        let PROJECT_ID = process.env.GCLOUD_PROJECT;
        if (!PROJECT_ID && process.env.FIREBASE_CONFIG) {
            PROJECT_ID = JSON.parse(process.env.FIREBASE_CONFIG).projectId;
        }
        if (!PROJECT_ID) return res.status(500).json({ error: "Google Cloud Project ID could not be identified." });

        const TOKEN = await dapatkanTokenAkses();
        const REGION = "us-central1";
        const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${REGION}/publishers/google/models/gemini-2.5-flash:generateContent`;

        const systemInstruction = `
        You are Core DevOps Git Agent AI. Analyze the user's message and return ONLY pure JSON without markdown codeblocks.
        CRITICAL RULE: The "jawabanAI" field MUST be written in the EXACT SAME LANGUAGE as the user's input.

        SKILL 1 (Create New Repo):
        {"isCommand": true, "action": "CREATE_REPO", "payload": { "namaRepo": "lowercase-with-hyphens", "visibilitas": "public" or "private" }, "jawabanAI": "(Acknowledge in user's language)"}

        SKILL 2 (Delete Repo):
        {"isCommand": true, "action": "DELETE_REPO", "payload": { "namaRepo": "target-repo-name" }, "jawabanAI": "(Acknowledge in user's language)"}

        SKILL 3 (Add Feature/Code):
        {"isCommand": true, "action": "ADD_FEATURE", "payload": { "namaRepo": "target-repo-name", "namaFile": "filename.ext", "isiKode": "Function Code" }, "jawabanAI": "(Acknowledge in user's language)"}

        CASUAL TALK:
        {"isCommand": false, "jawabanAI": "(Reply naturally in user's language)"}
        `;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
            body: JSON.stringify({ 
                contents: [{ role: "user", parts: [{ text: pesanUser }] }],
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            })
        });

        const data = await response.json();
        if (!data?.candidates?.[0]?.content) return res.status(500).json({ error: "Gemini AI response stream empty.", detail: data });

        const aiResult = JSON.parse(data.candidates[0].content.parts[0].text);

        if (aiResult.isCommand) {
            const { action, payload } = aiResult;
            if (!tokenUserGitLab) return res.json({ jawabanAI: "GitLab Access Token fields required.", status: "TOKEN_MISSING" });

            try {
                if (action === 'CREATE_REPO') {
                    const hasil = await eksekusiBuatRepo(payload.namaRepo, payload.visibilitas, tokenUserGitLab);
                    return res.json({ jawabanAI: aiResult.jawabanAI, status: "SUKSES_BUAT", detail: hasil });
                } 
                if (action === 'DELETE_REPO') {
                    return res.json({ jawabanAI: aiResult.jawabanAI, status: "MENUNGGU_KONFIRMASI_HAPUS", detail: { namaRepo: payload.namaRepo } });
                }
                if (action === 'ADD_FEATURE') {
                    const hasil = await eksekusiTambahFiturMR(payload.namaRepo, payload.namaFile, payload.isiKode, tokenUserGitLab);
                    return res.json({ jawabanAI: aiResult.jawabanAI, status: "MENUNGGU_REVIEW", detail: hasil });
                }
            } catch (errExec) {
                return res.json({ jawabanAI: "Operational pipeline crash.", error: errExec.message });
            }
        }

        return res.json({ jawabanAI: aiResult.jawabanAI });

    } catch (err) {
        return res.status(500).json({ error: "Internal Gateway Error", detail: err.message });
    }
});

app.post('/execute-delete', async (req, res) => {
    const { namaRepo, tokenUserGitLab } = req.body;
    if (!tokenUserGitLab) return res.status(400).json({ error: "Unauthorized operation." });
    try {
        const hasil = await eksekusiHapusRepo(namaRepo, tokenUserGitLab);
        res.json({ status: "SUKSES", detail: hasil });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

exports.api = onRequest({ region: "us-central1", cors: true }, app);