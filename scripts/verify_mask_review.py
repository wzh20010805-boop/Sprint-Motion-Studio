"""在只读 SQLite 快照的副本中对比旧、新便携包；绝不审核真实工作区。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]
PROJECT = "ab89e225-ec8a-4ecf-bd05-ef0956e95ad5"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def open_readonly(path):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def rows(connection, query, values=()):
    return [dict(row) for row in connection.execute(query, values)]


def source_state(connection):
    # 只比较真实项目的数据，不输出设置、凭证或完整任务内容。
    queries = {
        "project": "SELECT * FROM projects WHERE id=?",
        "frames": "SELECT * FROM frames WHERE project_id=? ORDER BY id",
        "heads": "SELECT h.* FROM mask_heads h JOIN frames f ON f.id=h.frame_id WHERE f.project_id=? ORDER BY h.frame_id",
        "versions": "SELECT v.* FROM mask_versions v JOIN frames f ON f.id=v.frame_id WHERE f.project_id=? ORDER BY v.id",
        "jobs": "SELECT * FROM jobs WHERE project_id=? ORDER BY id",
    }
    return {key: digest(json.dumps(rows(connection, query, (PROJECT,)), sort_keys=True).encode()) for key, query in queries.items()}


def original_paths(connection):
    paths = {row[0] for row in connection.execute("SELECT raw_path FROM frames WHERE project_id=?", (PROJECT,)) if row[0]}
    paths.update(row[0] for row in connection.execute("SELECT v.raw_path FROM mask_versions v JOIN frames f ON f.id=v.frame_id WHERE f.project_id=?", (PROJECT,)) if row[0])
    for source in rows(connection, "SELECT id,original_path FROM sources WHERE project_id=?", (PROJECT,)):
        paths.add(source["original_path"])
        for frame in rows(connection, "SELECT file FROM source_frames WHERE source_id=?", (source["id"],)):
            paths.add(str(Path(source["original_path"]).parent / frame["file"]))
    return sorted(paths)


def request(info, path, body=None):
    require(info["url"].startswith("http://127.0.0.1:"), "服务必须在本机回环地址")
    headers = {"Authorization": "Bearer " + info["token"]}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(info["url"] + path, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def compact_response(status, body):
    data = body.get("data", {})
    return {"http_status": status, "ok": body.get("ok"), "error": body.get("error"), "frame_id": data.get("frame_id"), "reviewed": data.get("reviewed"), "revision": data.get("revision"), "version_id": data.get("version_id")}


def verify_package(package, label, snapshot, evidence, expect_fixed):
    package = package.resolve()
    folder = evidence / label
    workspace = folder / "workspace"
    workspace.mkdir(parents=True)
    user = folder / "localappdata"
    user.mkdir()
    database = workspace / "framebaker.db"
    with open_readonly(snapshot) as source, sqlite3.connect(database) as clone:
        source.backup(clone)
    clone = sqlite3.connect(database)
    clone.row_factory = sqlite3.Row
    frames = rows(clone, "SELECT f.id,f.idx,h.reviewed,h.version_id FROM frames f JOIN mask_heads h ON h.frame_id=f.id WHERE f.project_id=? ORDER BY f.idx,f.id", (PROJECT,))
    require(len(frames) == 14, "本验收要求真实项目含 14 帧")
    before_jobs = rows(clone, "SELECT id,payload,result,status,requires_user_action FROM jobs WHERE project_id=? AND status='waiting_user'", (PROJECT,))
    current_ids = {row["id"] for row in frames}
    obsolete = [job["id"] for job in before_jobs if any(frame not in current_ids for frame in json.loads(job["payload"]).get("sceneMatting", {}).get("frame_ids", []))]
    require(len(obsolete) == 5, "本验收要求 5 个引用已删帧的历史任务")
    reset_ids = [frame["id"] for frame in frames[8:]]
    clone.executemany("UPDATE mask_heads SET reviewed=0 WHERE frame_id=?", ((frame,) for frame in reset_ids))
    # 增加明确标记的合成批次，验证真实的 14 帧全部审核前不会提前完成。
    batch_id = str(uuid.uuid4())
    clone.execute("INSERT INTO jobs(id,project_id,type,status,created_at,payload,result,requires_user_action) VALUES(?,?,'matting','waiting_user',?,?,?,1)", (batch_id, PROJECT, int(time.time() * 1000), json.dumps({"sceneMatting": {"project_id": PROJECT, "frame_ids": [frame["id"] for frame in frames]}, "verification_fixture": True}), json.dumps({"verification_fixture": True})))
    clone.commit()
    clone.close()
    env = {key: value for key, value in os.environ.items() if not key.startswith("SFS_")}
    env.update({"SFS_WORKSPACE": str(workspace), "LOCALAPPDATA": str(user), "SFS_REPO_ROOT": str(package), "SFS_IMAGE_PYTHON": str(package / "runtime/python/python.exe"), "SFS_MODEL_DIR": str(user / "SpriteMotionStudio/models"), "SFS_ASSET_DIR": str(package / "runtime/assets"), "SFS_IDLE_TIMEOUT_MS": "60000", "NUMBA_CACHE_DIR": str(user / "SpriteMotionStudio/cache/numba"), "PYTHONDONTWRITEBYTECODE": "1", "PORT": "0", "NODE_ENV": "production", "PATH": str(package / "runtime/bin") + ";C:\\Windows\\System32;C:\\Windows"})
    report = {"package": str(package), "version": json.loads((package / "sfs-package.json").read_text(encoding="utf-8"))["version"], "service_sha256": file_hash(package / "runtime/sfs-service.exe"), "cli_sha256": file_hash(package / "sfs.exe"), "workspace": str(workspace), "source_frames": frames, "fixture_reset_frame_ids": reset_ids, "fixture_batch_id": batch_id, "obsolete_job_ids": obsolete, "requests": []}
    process = None
    info = None
    try:
        with (folder / "service.log").open("wb") as log:
            process = subprocess.Popen([str(package / "runtime/sfs-service.exe")], cwd=package, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                require(process.poll() is None, "隔离服务提前退出；查看副本日志")
                if (workspace / ".sfs/service.json").exists():
                    info = json.loads((workspace / ".sfs/service.json").read_text(encoding="utf-8"))
                    require(info["pid"] == process.pid and Path(info["workspace"]).resolve() == workspace.resolve(), "拒绝访问不属于本验收的服务")
                    status, health = request(info, "/api/health")
                    require(status == 200 and health["pid"] == process.pid, "服务身份不匹配")
                    break
                time.sleep(0.1)
            require(info is not None, "隔离服务启动超时")
            report["owned_service_pid"] = process.pid
            cli = subprocess.run([str(package / "sfs.exe"), "project", "inspect", "--project", PROJECT, "--workspace", str(workspace), "--json"], cwd=folder, env=env, capture_output=True, timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
            require(cli.returncode == 0, "便携 CLI inspect 失败")
            inspected = json.loads(cli.stdout)
            require(inspected["ok"], "便携 CLI 返回失败")
            report["compiled_cli_inspect_exit"] = cli.returncode
            frame_id = frames[8]["id"]
            status, state = request(info, "/api/v1/masks/" + frame_id)
            require(status == 200 and state["data"]["reviewed"] is False, "第 9 帧在副本中应未确认")
            initial_revision = state["data"]["revision"]
            body = {"version_id": state["data"]["version_id"], "revision": initial_revision}
            status, first = request(info, "/api/v1/masks/" + frame_id + "/review", body)
            report["requests"].append(compact_response(status, first))
            if expect_fixed:
                require(status == 200 and first["data"]["reviewed"] is True and first["data"]["revision"] == initial_revision + 1, "新包确认必须成功且修订只增一次")
            else:
                require(status == 404 and first["error"]["code"] == "FRAME_NOT_FOUND", "旧包应重现首次 404")
            stale_status, stale = request(info, "/api/v1/masks/" + frame_id + "/review", body)
            report["requests"].append(compact_response(stale_status, stale))
            require(stale_status == 409 and stale["error"]["code"] == "REVISION_CONFLICT", "旧请求应得到修订冲突")
            status, actual = request(info, "/api/v1/masks/" + frame_id)
            require(actual["data"]["reviewed"] and actual["data"]["revision"] == initial_revision + 1, "确认状态和修订不符合预期")
            report["after_first_review"] = compact_response(status, actual)
            with open_readonly(database) as check:
                require(check.execute("SELECT status FROM jobs WHERE id=?", (batch_id,)).fetchone()[0] == "waiting_user", "未全部确认时当前批次必须等待")
            if expect_fixed:
                for frame in frames[9:]:
                    status, current = request(info, "/api/v1/masks/" + frame["id"])
                    require(status == 200 and not current["data"]["reviewed"], "剩余帧应仍未确认")
                    status, result = request(info, "/api/v1/masks/" + frame["id"] + "/review", {"version_id": current["data"]["version_id"], "revision": current["data"]["revision"]})
                    report["requests"].append(compact_response(status, result))
                    require(status == 200 and result["data"]["reviewed"], "剩余帧确认失败")
                    if frame is not frames[-1]:
                        with open_readonly(database) as check:
                            require(check.execute("SELECT status FROM jobs WHERE id=?", (batch_id,)).fetchone()[0] == "waiting_user", "当前批次不应提前完成")
            with open_readonly(database) as check:
                report["jobs"] = []
                for before in before_jobs:
                    after = dict(check.execute("SELECT * FROM jobs WHERE id=?", (before["id"],)).fetchone())
                    retained = before["payload"] == after["payload"] and before["result"] == after["result"]
                    require(retained, "历史任务 payload/result 不得改变")
                    expected = "cancelled" if before["id"] in obsolete else "done"
                    if expect_fixed:
                        require(after["status"] == expected and after["requires_user_action"] == 0, "任务状态不符合预期")
                    report["jobs"].append({"id": before["id"], "status": after["status"], "requires_user_action": after["requires_user_action"], "payload_result_retained": retained, "payload_sha256": digest(before["payload"].encode()), "result_sha256": digest((before["result"] or "").encode())})
                report["reviewed_frames"] = check.execute("SELECT COUNT(*) FROM mask_heads h JOIN frames f ON f.id=h.frame_id WHERE f.project_id=? AND reviewed=1", (PROJECT,)).fetchone()[0]
                report["fixture_batch_status"] = check.execute("SELECT status FROM jobs WHERE id=?", (batch_id,)).fetchone()[0]
                if expect_fixed:
                    require(report["reviewed_frames"] == 14 and report["fixture_batch_status"] == "done", "全部确认后应为 14/14 且当前批次完成")
            report["ok"] = True
    finally:
        if process is not None:
            if process.poll() is None:
                process.terminate()
            process.wait(timeout=10)
            report["owned_service_stopped"] = process.poll() is not None
        if info is not None:
            private_file = workspace / ".sfs/service.json"
            if private_file.exists():
                stored = json.loads(private_file.read_text(encoding="utf-8"))
                stored["token"] = "[REDACTED_AFTER_TEST]"
                write_json(private_file, stored)
        write_json(folder / "result.json", report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--old-package", type=Path, default=ROOT / "fixtures/generated/archived-installers/before-1.0.5/SpriteMotionStudio-1.0.4")
    parser.add_argument("--new-package", type=Path, default=ROOT / "dist/最新便携版/SpriteMotionStudio-1.0.5")
    args = parser.parse_args()
    evidence = ROOT / "fixtures/generated/mask-review-portable" / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
    evidence.mkdir(parents=True)
    source_db = ROOT / "workspaces/default/framebaker.db"
    snapshot = evidence / "readonly-source-snapshot.db"
    with open_readonly(source_db) as original:
        state_before = source_state(original)
        hashes_before = {path: file_hash(path) for path in original_paths(original)}
        with sqlite3.connect(snapshot) as destination:
            original.backup(destination)
    report = {"source_database": str(source_db), "snapshot_sha256": file_hash(snapshot), "evidence": str(evidence), "project_id": PROJECT, "read_only_source": True}
    try:
        old = verify_package(args.old_package, "old-1.0.4", snapshot, evidence, False)
        new = verify_package(args.new_package, "new-1.0.5", snapshot, evidence, True)
        report.update({"old_first_status": old["requests"][0]["http_status"], "old_second_status": old["requests"][1]["http_status"], "new_first_status": new["requests"][0]["http_status"], "new_stale_status": new["requests"][1]["http_status"], "new_reviewed_frames": new["reviewed_frames"], "obsolete_jobs_cancelled": len(new["obsolete_job_ids"]), "payload_result_retained": all(job["payload_result_retained"] for job in new["jobs"]), "current_batch_waited_then_done": new["fixture_batch_status"] == "done", "owned_services_stopped": old["owned_service_stopped"] and new["owned_service_stopped"], "ok": True})
    finally:
        with open_readonly(source_db) as original:
            state_after = source_state(original)
        hashes_after = {path: file_hash(path) for path in hashes_before}
        report["original_project_database_unchanged"] = state_before == state_after
        report["original_image_files_hashed"] = len(hashes_before)
        report["original_image_hashes_unchanged"] = hashes_before == hashes_after
        write_json(evidence / "original-preservation.json", {"database_before": state_before, "database_after": state_after, "image_hashes_before": hashes_before, "image_hashes_after": hashes_after})
        write_json(evidence / "summary.json", report)
        print(json.dumps(report, ensure_ascii=False, indent=2))
    require(report["original_project_database_unchanged"] and report["original_image_hashes_unchanged"], "真实项目数据在验收期间发生变化，请检查证据")


if __name__ == "__main__":
    main()
