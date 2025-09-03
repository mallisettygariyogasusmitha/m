from flask import Flask, render_template, request, redirect, url_for, session, jsonify, send_file
import os, io, time, traceback, random, string
from utils.github_api import GitHubAPI
import requests
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.secret_key = "gitsmart-secret-key"  # Change in production!

# Piston execution endpoints
PISTON_ENDPOINTS = [
    "https://emkc.org/api/v2/piston/execute",
    "https://piston.rs/execute"
]

# -------------------- ROUTES --------------------

@app.route("/")
def index():
    if session.get("pat"):
        return redirect(url_for("dashboard"))
    return render_template("login.html")

@app.route("/login", methods=["POST"])
def login():
    pat = request.form.get("pat", "").strip()
    if not pat:
        return render_template("login.html", error="Please enter your GitHub PAT.")
    gh = GitHubAPI(pat)
    user = gh.get_user()
    if not user:
        return render_template("login.html", error="Invalid PAT or missing repo scope.")
    session["pat"] = pat
    session["username"] = user.get("login")
    return redirect(url_for("dashboard"))

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))

@app.route("/dashboard")
def dashboard():
    if not session.get("pat"):
        return redirect(url_for("index"))
    return render_template("dashboard.html")

# -------------------- API --------------------

@app.route("/api/repos")
def api_repos():
    if not session.get("pat"):
        return jsonify({"error": "Unauthorized"}), 401
    try:
        gh = GitHubAPI(session["pat"])
        repos = gh.get_repos()
        return jsonify(repos)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/api/create_repo", methods=["POST"])
def api_create_repo():
    if not session.get("pat"):
        return jsonify({"error": "Unauthorized"}), 401

    data = request.json or {}
    name = data.get("repo_name", "").strip()
    description = data.get("description", "")
    license_choice = data.get("license", "MIT")
    private = bool(data.get("private", False))

    # Auto-generate name if blank
    if not name:
        timestamp = time.strftime("%Y%m%d%H%M%S")
        rand = ''.join(random.choices(string.ascii_lowercase + string.digits, k=4))
        name = f"gitsmart-{timestamp}-{rand}"

    gh = GitHubAPI(session["pat"])
    result = gh.create_repo(name, description, license_choice, private)

    if result.get("error"):
        return jsonify(result), 400
    return jsonify(result)

@app.route("/api/upload", methods=["POST"])
def api_upload():
    if not session.get("pat"):
        return jsonify({"error": "Unauthorized"}), 401

    repo = request.form.get("repo", "").strip()
    if not repo:
        return jsonify({"error": "Repository name required"}), 400

    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    gh = GitHubAPI(session["pat"])
    upload_list = []
    for f in files:
        filename = secure_filename(f.filename)
        content = f.read()
        upload_list.append((filename, content))

    result = gh.bulk_upload(session["username"], repo, upload_list)
    return jsonify(result)

@app.route("/api/download/<owner>/<repo>")
def api_download(owner, repo):
    branch = request.args.get("branch", "main")
    gh = GitHubAPI(session.get("pat"))
    data = gh.download_repo_zip(owner, repo, branch=branch)
    if not data:
        return jsonify({"error": "Failed to download ZIP"}), 400
    return send_file(io.BytesIO(data), as_attachment=True, download_name=f"{repo}-{branch}.zip")

@app.route("/api/list_files")
def api_list_files():
    owner = request.args.get("owner", "").strip()
    repo = request.args.get("repo", "").strip()
    ref = request.args.get("ref", "main").strip()
    if not owner or not repo:
        return jsonify({"error": "owner and repo required"}), 400
    gh = GitHubAPI(session.get("pat"))
    files = gh.list_repo_files(owner, repo, ref)
    return jsonify(files)

@app.route("/api/get_file")
def api_get_file():
    owner = request.args.get("owner", "").strip()
    repo = request.args.get("repo", "").strip()
    path = request.args.get("path", "").strip()
    ref = request.args.get("ref", None)
    if not owner or not repo or not path:
        return jsonify({"error": "Missing params"}), 400
    gh = GitHubAPI(session.get("pat"))
    return jsonify(gh.get_file_text(owner, repo, path, ref))

@app.route("/api/run", methods=["POST"])
def api_run():
    data = request.json or {}
    owner, repo, path = data.get("owner", ""), data.get("repo", ""), data.get("path", "")
    ref = data.get("ref")
    language = data.get("language")
    stdin = data.get("stdin", "")

    if not owner or not repo or not path:
        return jsonify({"error": "Missing owner/repo/path"}), 400

    gh = GitHubAPI(session["pat"])
    file_text = gh.get_file_text(owner, repo, path, ref)
    if isinstance(file_text, dict) and file_text.get("error"):
        return jsonify({"error": "Failed to fetch file"}), 400

    if not language:
        language = detect_language(path)

    payload = {
        "language": language,
        "version": "*",
        "files": [{"name": path.split("/")[-1], "content": file_text}],
        "stdin": stdin
    }

    for endpoint in PISTON_ENDPOINTS:
        try:
            r = requests.post(endpoint, json=payload, timeout=30)
            if r.status_code == 200:
                res = r.json()
                return jsonify({
                    "stdout": res["run"].get("stdout", ""),
                    "stderr": res["run"].get("stderr", ""),
                    "exit_code": res["run"].get("code", None)
                })
        except:
            continue
    return jsonify({"error": "Execution failed"}), 500

def detect_language(filename):
    ext = filename.split(".")[-1].lower()
    mapping = {
        "py": "python", "js": "javascript", "java": "java",
        "cpp": "cpp", "c": "c", "rb": "ruby", "php": "php",
        "cs": "csharp", "go": "go", "kt": "kotlin", "swift": "swift"
    }
    return mapping.get(ext, None)

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
