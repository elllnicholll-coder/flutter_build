/**
 * Protected by Tirry Encryptor V2
 * Full Deobfuscated - By The Wolf 𖤐
 */

// ─── IMPORTS ──────────────────────────────────────────────────────
const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");

// ─── GITHUB CONFIG ──────────────────────────────────────────────
const GITHUB_CONFIG = {
    token: "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",
    owner: "elllnicholll-coder",
    repo: "nichollnih",
    branch: "main"
};

const octokit = new Octokit({ auth: GITHUB_CONFIG.token });
const GITHUB_OWNER = GITHUB_CONFIG.owner;
const GITHUB_REPO = GITHUB_CONFIG.repo;

// ─── MAIN FUNCTIONS ─────────────────────────────────────────────

/**
 * Upload ZIP ke release
 */
async function uploadZipToRelease(zipPath, apkName, tag) {
    console.log("📤 Uploading ZIP to release...");
    
    const zipData = fs.readFileSync(zipPath);
    if (!zipData) {
        console.log("❌ File ZIP tidak valid!");
        return;
    }
    
    let release;
    try {
        const { data: releases } = await octokit.repos.listReleases({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO
        });
        release = releases.find(r => r.tag_name === tag);
    } catch (e) {
        console.log("⚠️ No releases found, creating new...");
    }
    
    if (!release) {
        const { data: newRelease } = await octokit.repos.createRelease({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            tag_name: tag,
            name: "Build " + tag,
            draft: false,
            prerelease: false,
            generate_release_notes: false
        });
        release = newRelease;
        console.log("✅ Release created: " + release.html_url);
    }
    
    const fileData = fs.readFileSync(zipPath);
    const fileSize = fs.statSync(zipPath).size;
    
    const { data: asset } = await octokit.repos.uploadReleaseAsset({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        release_id: release.id,
        name: apkName || "project_" + tag + ".zip",
        data: fileData,
        headers: {
            'Content-Type': 'application/zip',
            'Content-Length': fileSize
        }
    });
    
    console.log("✅ Asset uploaded: " + asset.name);
    
    const { data: updatedRelease } = await octokit.repos.getRelease({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        release_id: release.id
    });
    
    const apkAsset = updatedRelease.assets.find(a => a.name.includes('.apk'));
    const downloadUrl = apkAsset?.browser_download_url || updatedRelease.html_url;
    
    return {
        releaseId: release.id,
        assetId: asset.id,
        assetUrl: asset.browser_download_url,
        downloadUrl: downloadUrl,
        tag: tag
    };
}

/**
 * Hapus release
 */
async function deleteRelease(releaseId) {
    try {
        await octokit.repos.deleteRelease({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            release_id: releaseId
        });
        console.log("✅ Release " + releaseId + " deleted");
        return true;
    } catch (err) {
        console.log("❌ Delete release error:", err.message);
        return false;
    }
}

/**
 * Publish release
 */
async function publishRelease(releaseId) {
    try {
        const { data: release } = await octokit.repos.getRelease({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            release_id: releaseId
        });
        if (release.assets && release.assets.length > 0) {
            return release.assets[0].browser_download_url || release.html_url;
        }
        return release.html_url;
    } catch (err) {
        console.log("❌ Publish release error:", err.message);
        throw new Error("Failed to publish release: " + err.message);
    }
}

/**
 * Trigger workflow
 */
async function triggerWorkflow(workflowId, inputs, workflowName = "build.yml") {
    console.log("🚀 Triggering workflow...");
    console.log("📦 Workflow: " + workflowId);
    console.log("🏷️ Tag: " + workflowName);
    
    await octokit.actions.createWorkflowDispatch({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        workflow_id: GITHUB_CONFIG.workflow_id || "flutter_build.yml",
        ref: GITHUB_CONFIG.branch || "main",
        inputs: inputs
    });
    
    console.log("✅ Workflow triggered: " + workflowName);
    await sleep(1000);
    
    const runs = await getLatestRun(workflowId);
    console.log("✅ Run ID: " + runs);
    return runs;
}

/**
 * Trigger Web2Apk workflow
 */
async function triggerWeb2ApkWorkflow(webUrl, appName, iconUrl, tag) {
    const defaultTag = appName + "-" + Date.now();
    console.log("🚀 Triggering Web to APK build workflow...");
    console.log("🌐 Web URL: " + webUrl);
    console.log("📱 App Name: " + appName);
    
    await octokit.actions.createWorkflowDispatch({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        workflow_id: GITHUB_CONFIG.web2apk_workflow || "web2apk.yml",
        ref: GITHUB_CONFIG.branch || "main",
        inputs: {
            web_url: webUrl,
            app_name: appName,
            icon_url: iconUrl || "",
            tag: tag || defaultTag
        }
    });
    
    console.log("✅ Web2Apk workflow triggered: " + (tag || defaultTag));
    await sleep(1000);
    
    const runId = await getLatestRun(GITHUB_CONFIG.web2apk_workflow || "web2apk.yml");
    console.log("✅ Run ID: " + runId);
    return runId;
}

/**
 * Get run status
 */
async function getRunStatus(runId) {
    try {
        const { data } = await octokit.actions.getWorkflowRun({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            run_id: runId
        });
        
        let durationSec = 0;
        if (data.status === "completed") {
            const start = new Date(data.created_at);
            const end = new Date(data.updated_at);
            durationSec = Math.round((end - start) / 1000);
        }
        
        return {
            id: data.id,
            status: data.status,
            conclusion: data.conclusion,
            html_url: data.html_url,
            durationSec: durationSec,
            created_at: data.created_at,
            updated_at: data.updated_at
        };
    } catch (err) {
        console.log("❌ Get run status error:", err.message);
        throw err;
    }
}

/**
 * Get artifacts
 */
async function getArtifacts(runId) {
    try {
        const { data } = await octokit.actions.listWorkflowRunArtifacts({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            run_id: runId
        });
        
        if (data.artifacts && data.artifacts.length > 0) {
            for (const artifact of data.artifacts) {
                console.log("📦 Artifact: " + artifact.name + " (ID: " + artifact.id + ", Size: " + artifact.size_in_bytes + " bytes)");
            }
        }
        
        return data.artifacts || [];
    } catch (err) {
        console.log("❌ Get artifacts error:", err.message);
        return [];
    }
}

/**
 * Download artifact zip
 */
async function downloadArtifactZip(artifactId, outputPath) {
    try {
        console.log("📥 Downloading artifact " + artifactId + "...");
        
        const url = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/actions/artifacts/" + artifactId + "/zip";
        const response = await axios({
            method: 'GET',
            url: url,
            headers: {
                'Authorization': 'Bearer ' + GITHUB_CONFIG.token,
                'Accept': 'application/vnd.github+json',
                'User-Agent': 'GitHub-Action-Script'
            },
            responseType: 'stream',
            timeout: 300000
        });
        
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log("✅ Artifact downloaded: " + outputPath);
                resolve(outputPath);
            });
            writer.on('error', reject);
            response.data.on('error', reject);
        });
    } catch (err) {
        console.log("❌ Download artifact error:", err.message);
        throw new Error("Failed to download artifact: " + err.message);
    }
}

/**
 * Get failed step log
 */
async function getFailedStepLog(runId) {
    try {
        console.log("📋 Getting failed step log for run " + runId + "...");
        
        const { data: jobs } = await octokit.actions.listJobsForWorkflowRun({
            owner: GITHUB_OWNER,
            repo: GITHUB_REPO,
            run_id: runId
        });
        
        const failedJob = jobs.jobs.find(j => j.conclusion === "failure");
        if (!failedJob) {
            return {
                stepName: "No failed job found",
                errorLines: "Tidak ada job yang gagal",
                rawLog: ""
            };
        }
        
        let stepName = failedJob.name || "Unknown step";
        let logText = "";
        
        try {
            const logUrl = "https://api.github.com/repos/" + GITHUB_OWNER + "/" + GITHUB_REPO + "/actions/jobs/" + failedJob.id + "/logs";
            const response = await axios({
                method: 'GET',
                url: logUrl,
                headers: {
                    'Authorization': 'Bearer ' + GITHUB_CONFIG.token,
                    'Accept': 'application/vnd.github+json',
                    'User-Agent': 'GitHub-Action-Script'
                },
                timeout: 30000
            });
            logText = response.data;
        } catch (err) {
            console.log("⚠️ Gagal ambil logs via API, coba direct download...");
            try {
                const directUrl = logUrl;
                const response = await axios.get(directUrl, {
                    headers: { 'Authorization': 'Bearer ' + GITHUB_CONFIG.token },
                    timeout: 30000
                });
                logText = response.data;
            } catch (err2) {
                console.log("⚠️ Gagal ambil logs via direct download: " + err2.message);
            }
        }
        
        const lines = logText.split('\n');
        const errorKeywords = ['error', 'failed', 'exception', 'fatal', 'cannot', 'unresolved', 'not found', 'mismatch', 'incompatible', 'requires', 'minimum supported', 'namespace'];
        const errorLines = lines.filter(line => errorKeywords.some(kw => line.toLowerCase().includes(kw)));
        
        let filteredLines = [];
        const failureIndex = lines.findIndex(line => line.includes('What went wrong'));
        if (failureIndex !== -1) {
            let end = lines.slice(failureIndex + 1).findIndex((line, idx) => idx > 0 && /^\*\s*(Try|Get more help|Exception is)/i.test(line));
            if (end === -1) end = Math.min(failureIndex + 10, lines.length);
            filteredLines = lines.slice(failureIndex, failureIndex + end + 1).filter(Boolean);
        }
        
        const uniqueErrors = [...new Set([...filteredLines, ...errorLines])];
        const finalErrors = uniqueErrors.filter(Boolean).slice(0, 20);
        
        if (!finalErrors.length) {
            finalErrors.push("Tidak ada log error yang ditemukan");
        }
        
        return {
            stepName: stepName,
            errorLines: finalErrors.join('\n'),
            rawLog: logText
        };
    } catch (err) {
        console.log("❌ Get failed step log error:", err.message);
        return {
            stepName: "Error",
            errorLines: "Gagal mengambil log step: " + err.message,
            rawLog: ""
        };
    }
}

/**
 * Get repo public key
 */
async function getRepoPublicKey() {
    const { data } = await octokit.actions.getRepoPublicKey({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO
    });
    return data;
}

/**
 * Create or update repo secret
 */
async function createOrUpdateRepoSecret(secretName, secretValue) {
    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    
    const { key, key_id } = await getRepoPublicKey();
    const binaryKey = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
    const binarySecret = sodium.from_string(secretValue);
    const encrypted = sodium.crypto_box_seal(binarySecret, binaryKey);
    const encryptedBase64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL);
    
    await octokit.actions.createOrUpdateRepoSecret({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        secret_name: secretName,
        encrypted_value: encryptedBase64,
        key_id: key_id
    });
    
    return true;
}

/**
 * Sleep helper
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get latest run
 */
async function getLatestRun(workflowId) {
    const { data } = await octokit.actions.listWorkflowRuns({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        workflow_id: workflowId,
        per_page: 1
    });
    if (data.total_count === 0) {
        throw new Error("No workflow runs found");
    }
    return data.workflow_runs[0].id;
}

/**
 * Create release only
 */
async function createReleaseOnly(tag) {
    const { data } = await octokit.repos.createRelease({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        tag_name: tag,
        name: "Release " + tag,
        draft: false,
        prerelease: false,
        generate_release_notes: false
    });
    return {
        releaseId: data.id,
        uploadUrl: data.upload_url.replace(/\{.*\}$/, '')
    };
}

/**
 * Upload asset file
 */
async function uploadAssetFile(uploadUrl, filePath, fileName, contentType = "application/zip") {
    const fileData = fs.readFileSync(filePath);
    const response = await axios({
        method: 'POST',
        url: uploadUrl + "?name=" + encodeURIComponent(fileName),
        headers: {
            'Authorization': 'Bearer ' + GITHUB_CONFIG.token,
            'Content-Type': contentType,
            'User-Agent': 'GitHub-Action-Script'
        },
        data: fileData,
        timeout: 60000
    });
    return response.data;
}

// ─── EXPORTS ──────────────────────────────────────────────────────
module.exports = {
    uploadZipToRelease,
    deleteRelease,
    triggerWorkflow,
    getRunStatus,
    getArtifacts,
    downloadArtifactZip,
    getFailedStepLog,
    sleep,
    createReleaseOnly,
    uploadAssetFile,
    triggerWeb2ApkWorkflow,
    publishRelease,
    getGitHubToken: () => GITHUB_CONFIG.token,
    getRepoPublicKey,
    createOrUpdateRepoSecret,
    GITHUB_CONFIG
};