let currentRunController = null;
const HISTORY_KEY = "gitsmart_run_history_v1";

function toast(msg) { alert(msg); }

// ---------------- Load Repositories ----------------
async function loadRepos() {
  try {
    const res = await fetch("/api/repos");
    const json = await res.json();
    const container = document.getElementById("reposContainer");

    if (json.error) {
      container.innerHTML = `<div class="error">${json.error}</div>`;
      return;
    }

    container.innerHTML = "";
    for (const r of json) {
      const owner = r.full_name.split("/")[0];
      const displayFull = r.full_name;

      const card = document.createElement("div");
      card.className = "repo-card";

      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center">
          <a href="${r.html_url}" target="_blank">${displayFull}</a>
          <span class="badge ${r.private ? 'private':'public'}">${r.private ? 'Private':'Public'}</span>
        </div>
        <div class="repo-meta">
          Created: ${new Date(r.created_at).toLocaleString()} • Updated: ${new Date(r.updated_at).toLocaleString()}
        </div>
        <div style="margin-top:8px;">⭐ ${r.stargazers_count} | Forks: ${r.forks_count} | Issues: ${r.open_issues_count}</div>
        <div class="row" style="margin-top:8px">
          <button class="btn small" onclick="downloadRepo('${owner}','${r.name}','${r.default_branch || 'main'}')">Download ZIP</button>
          <button class="btn outline small" onclick="prefillRun('${owner}','${r.name}','${r.default_branch || 'main'}')">Run Code</button>
        </div>`;
      container.appendChild(card);
    }
  } catch (e) {
    console.error(e);
    document.getElementById("reposContainer").innerHTML = `<div class="error">Failed to load repos: ${e.message}</div>`;
  }
}

// ---------------- Download Repo ----------------
async function downloadRepo(owner, repo, branch) {
  try {
    const url = `/api/download/${owner}/${repo}?branch=${encodeURIComponent(branch)}`;
    window.open(url, "_blank");
  } catch (e) {
    toast("Failed to download: " + e.message);
  }
}

// ---------------- Prefill Run Section ----------------
function prefillRun(owner, repo, ref) {
  document.getElementById("rc-owner").value = owner;
  document.getElementById("rc-repo").value = repo;
  document.getElementById("rc-ref").value = ref || "main";
  listPublicFiles();
}

// ---------------- Create Repo ----------------
document.getElementById("createRepoBtn").addEventListener("click", async () => {
  const name = document.getElementById("create-name").value.trim();
  const description = document.getElementById("create-desc").value.trim();
  const license = document.getElementById("create-license").value;
  const isPrivate = document.getElementById("create-private").checked;

  const res = await fetch("/api/create_repo", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({repo_name: name, description, license, private: isPrivate})
  });

  const j = await res.json();
  if (j.error) {
    toast("Create failed: " + (j.error || JSON.stringify(j)));
  } else {
    toast("Repository created: " + (j.html_url || j.repo || name));
    setTimeout(loadRepos, 800);
  }
});

// ---------------- Upload Files ----------------
document.getElementById("uploadBtn").addEventListener("click", async () => {
  const repoVal = document.getElementById("upload-repo").value.trim();
  const files = document.getElementById("upload-files").files;

  if (!repoVal) { toast("Enter repo (owner/repo or repo)"); return; }
  if (!files || files.length === 0) { toast("Select files to upload"); return; }

  const fd = new FormData();
  fd.append("repo", repoVal);
  for (const f of files) fd.append("files", f);

  const res = await fetch("/api/upload", {method:"POST", body: fd});
  const j = await res.json();

  const resultsBox = document.getElementById("uploadResults");
  const list = document.getElementById("uploadResultList");
  resultsBox.style.display = "block";
  list.innerHTML = "";

  if (j.results) {
    toast("Upload completed");
    setTimeout(loadRepos, 1000);
    j.results.forEach(file => {
      const li = document.createElement("li");
      if (file && file.success) {
        li.innerHTML = `✔ ${file.file} — ${file.commit_url ? `<a href="${file.commit_url}" target="_blank">View Commit</a>` : 'Committed'}`;
      } else {
        li.innerHTML = `❌ ${file.file || '(unknown)'} — Error: ${file.error || 'Unknown'}`;
      }
      list.appendChild(li);
    });
  } else {
    toast("Upload error: " + (j.error || JSON.stringify(j)));
    const li = document.createElement("li");
    li.textContent = "Error: " + (j.error || "Unknown");
    list.appendChild(li);
  }
});

// ---------------- List Files ----------------
document.getElementById("rc-list").addEventListener("click", listPublicFiles);
async function listPublicFiles() {
  const owner = document.getElementById("rc-owner").value.trim();
  const repo = document.getElementById("rc-repo").value.trim();
  const ref = (document.getElementById("rc-ref").value || "main").trim();

  if (!owner || !repo) { toast("owner & repo required"); return; }

  const res = await fetch(`/api/list_files?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
  const data = await res.json();
  const sel = document.getElementById("rc-file");
  sel.innerHTML = "";

  if (Array.isArray(data)) {
    const filtered = data.filter(p => /\.[a-zA-Z0-9]+$/.test(p));
    filtered.forEach(p => {
      const o = document.createElement("option");
      o.value = p; o.textContent = p; sel.appendChild(o);
    });
    if (filtered.length === 0) {
      sel.innerHTML = "<option value=''>No files found</option>";
    }
  } else {
    sel.innerHTML = "<option value=''>Error listing files</option>";
    toast("Error: " + (data.error || JSON.stringify(data)));
  }
}

// ---------------- Run Code ----------------
document.getElementById("rc-run").addEventListener("click", async () => {
  const owner = document.getElementById("rc-owner").value.trim();
  const repo = document.getElementById("rc-repo").value.trim();
  const ref = (document.getElementById("rc-ref").value || "main").trim();
  const path = document.getElementById("rc-file").value;
  const language = document.getElementById("rc-language").value.trim();
  const stdin = document.getElementById("rc-stdin").value || "";

  if (!owner || !repo || !path) { toast("owner, repo and file required"); return; }

  if (currentRunController) {
    try { currentRunController.abort(); } catch(e){}
  }
  currentRunController = new AbortController();
  const signal = currentRunController.signal;

  document.getElementById("rc-status").textContent = "Running...";
  document.getElementById("rc-stdout").textContent = "";
  document.getElementById("rc-stderr").textContent = "";

  const payload = { owner, repo, path, ref, language: language || undefined, stdin };

  try {
    const res = await fetch("/api/run", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(payload),
      signal
    });

    const j = await res.json();
    if (!res.ok || j.error) {
      document.getElementById("rc-status").textContent = "Error";
      document.getElementById("rc-stderr").textContent = JSON.stringify(j, null, 2);
      pushHistory({owner, repo, path, language, status:"error", time: Date.now(), error: j});
      return;
    }

    document.getElementById("rc-status").textContent = "Done";
    document.getElementById("rc-stdout").textContent = j.stdout || "";
    document.getElementById("rc-stderr").textContent = j.stderr || "";

    pushHistory({owner, repo, path, language, status:"ok", time: Date.now(), stdout: j.stdout, stderr: j.stderr});
  } catch (err) {
    if (err.name === "AbortError") {
      document.getElementById("rc-status").textContent = "Stopped";
      document.getElementById("rc-stderr").textContent = "Execution aborted by user.";
      pushHistory({owner, repo, path, status:"stopped", time: Date.now()});
    } else {
      document.getElementById("rc-status").textContent = "Failed";
      document.getElementById("rc-stderr").textContent = String(err);
      pushHistory({owner, repo, path, status:"error", time: Date.now(), error: String(err)});
    }
  } finally {
    currentRunController = null;
    renderHistory();
  }
});

// ---------------- Stop Run ----------------
document.getElementById("rc-stop").addEventListener("click", () => {
  if (currentRunController) {
    try { currentRunController.abort(); } catch(e){}
    currentRunController = null;
    document.getElementById("rc-status").textContent = "Stopped";
    document.getElementById("rc-stderr").textContent = "Execution stopped by user.";
    pushHistory({
      owner: document.getElementById("rc-owner").value,
      repo: document.getElementById("rc-repo").value,
      path: document.getElementById("rc-file").value,
      status:"stopped", time: Date.now()
    });
    renderHistory();
  }
});

// ---------------- Run History ----------------
function pushHistory(entry) {
  let arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  arr.unshift(entry);
  if (arr.length > 100) arr.pop();
  localStorage.setItem(HISTORY_KEY, JSON.stringify(arr));
  renderHistory();
}
function renderHistory() {
  const container = document.getElementById("historyList");
  container.innerHTML = "";
  const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  arr.forEach((it, idx) => {
    const li = document.createElement("li");
    const time = new Date(it.time).toLocaleString();
    li.innerHTML = `<strong>${it.owner||''}/${it.repo||''}</strong> ${it.path||''} — <em>${it.status}</em> <span class="muted"> ${time}</span>
      <div style="margin-top:6px"><button class="btn small" onclick='showDetails(${idx})'>Details</button></div>`;
    container.appendChild(li);
  });
}
function showDetails(idx) {
  const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  const it = arr[idx];
  if (!it) return;
  alert(JSON.stringify(it, null, 2));
}
document.getElementById("clearHistory").addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
});

// ---------------- Init ----------------
document.getElementById("refreshRepos").addEventListener("click", loadRepos);
window.addEventListener("load", () => { loadRepos(); renderHistory(); });
