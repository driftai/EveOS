class WorldBookHandler(SimpleHTTPRequestHandler):
    server_version = "WorldBook/0.9"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, format_string: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format_string % args}")

    def allowed_health_origin(self) -> str:
        origin = str(self.headers.get("Origin") or "")
        if origin == "null":
            return origin
        parsed = urlparse(origin)
        if parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
            return origin
        return ""

    def end_headers(self) -> None:
        parsed_request = urlparse(self.path)
        if parsed_request.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif "v=" in parsed_request.query:
            # Versioned UI assets are content-addressed by EveOS/World Book cache tokens.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # Keep editable local files fresh while still allowing fast conditional reloads.
            self.send_header("Cache-Control", "no-cache")
        if parsed_request.path == "/api/health":
            allowed_origin = self.allowed_health_origin()
            if allowed_origin:
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Vary", "Origin")
                if str(self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def send_json(self, payload: object, status: int = 200, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "error": message}, status)

    def read_json_body(self) -> dict:
        content_length = int(self.headers.get("Content-Length", "0") or "0")
        if content_length > MAX_REQUEST_BYTES:
            raise ValueError("Request is too large.")
        raw = self.rfile.read(content_length) if content_length else b"{}"
        payload = json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Request body must be a JSON object.")
        return payload

    def do_OPTIONS(self) -> None:
        if urlparse(self.path).path != "/api/health" or not self.allowed_health_origin():
            self.send_response(HTTPStatus.FORBIDDEN)
            self.end_headers()
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return super().do_GET()

        query = parse_qs(parsed.query)

        try:
            if parsed.path == "/api/health":
                return self.send_json({
                    "ok": True,
                    "service": "world-book",
                    "appVersion": APP_VERSION,
                    "instanceId": SERVER_INSTANCE_ID,
                })

            if handle_recovery_get(self, parsed):
                return

            if handle_narration_get(self, parsed, query):
                return

            if handle_world_portal_get(self, parsed): return

            if parsed.path == "/api/config":
                root_value = str(CONFIG.get("rootPath") or "")
                root_exists = bool(root_value and Path(root_value).expanduser().is_dir())
                return self.send_json({
                    "ok": True,
                    "config": CONFIG,
                    "rootExists": root_exists,
                    "appVersion": APP_VERSION,
                })

            if parsed.path == "/api/state":
                with LOCK:
                    payload = json.loads(json.dumps(STATE))
                return self.send_json({"ok": True, "state": payload})

            if parsed.path == "/api/list":
                relative_path = query.get("path", [""])[0]
                return self.send_json({
                    "ok": True,
                    "path": relative_path,
                    "entries": list_directory(relative_path),
                })

            if parsed.path == "/api/read":
                relative_path = query.get("path", [""])[0]
                target, normalized = resolve_relative(relative_path)
                if not target.is_file():
                    raise FileNotFoundError("Selected item is not a file.")

                content, editable, format_name = read_supported_file(target)
                return self.send_json({
                    "ok": True,
                    "path": normalized,
                    "content": content,
                    "editable": editable,
                    "format": format_name,
                    "entry": entry_info(target, normalized),
                })

            if parsed.path == "/api/search":
                search_query = query.get("q", [""])[0]
                return self.send_json({
                    "ok": True,
                    "query": search_query,
                    "entries": search_workspace(search_query),
                })

            if parsed.path == "/api/tag-index":
                return self.send_json({"ok": True, "entries": tagged_physical_index()})

            if parsed.path == "/api/imports":
                with LOCK:
                    imports = json.loads(json.dumps(STATE.get("imports", [])))
                return self.send_json({"ok": True, "imports": imports})

            if parsed.path == "/api/import":
                import_id = query.get("id", [""])[0]
                if not import_id:
                    raise ValueError("Snapshot id is required.")
                import_path = IMPORTS_DIR / f"{import_id}.json"
                if not import_path.exists():
                    raise FileNotFoundError("Imported snapshot was not found.")
                return self.send_json({
                    "ok": True,
                    "snapshot": json.loads(import_path.read_text(encoding="utf-8")),
                })

            if parsed.path == "/api/export":
                snapshot = build_snapshot()
                body = json.dumps(snapshot, indent=2, ensure_ascii=False).encode("utf-8")
                safe_title = "".join(
                    ch if ch.isalnum() or ch in "-_" else "-"
                    for ch in str(snapshot.get("project", {}).get("title") or "world-book")
                ).strip("-") or "world-book"
                filename = f"{safe_title}-{datetime.now().date().isoformat()}.json"

                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            return self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")

        except FileNotFoundError as exc:
            return self.send_error_json(HTTPStatus.NOT_FOUND, str(exc))
        except (ValueError, PermissionError, NotADirectoryError) as exc:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            print(f"GET error: {exc}")
            return self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown endpoint.")

        try:
            if handle_recovery_post_raw(self, parsed):
                return

            if handle_narration_post_raw(self, parsed):
                return

            if handle_world_portal_post(self, parsed): return

            payload = self.read_json_body()
            if handle_recovery_post_json(self, parsed, payload):
                return

            if handle_narration_post_json(self, parsed, payload):
                return

            if parsed.path == "/api/config":
                root_path = str(payload.get("rootPath") or "").strip()
                if not root_path:
                    raise ValueError("Enter a workspace folder path.")

                root = Path(root_path).expanduser()
                if not root.exists():
                    raise FileNotFoundError(f"Workspace path does not exist: {root}")
                if not root.is_dir():
                    raise NotADirectoryError(f"Workspace path is not a folder: {root}")

                with LOCK:
                    CONFIG["rootPath"] = str(root.resolve())
                    save_config()

                return self.send_json({
                    "ok": True,
                    "config": CONFIG,
                    "rootEntry": entry_info(root.resolve(), ""),
                })

            if parsed.path == "/api/state":
                incoming = payload.get("state")
                if not isinstance(incoming, dict):
                    raise ValueError("State payload is missing.")

                with LOCK:
                    STATE.clear()
                    STATE.update(incoming)
                    STATE.setdefault("schemaVersion", SCHEMA_VERSION)
                    STATE.setdefault("appVersion", APP_VERSION)
                    STATE.setdefault("project", default_state()["project"])
                    STATE.setdefault("virtualRoot", default_virtual_root())
                    STATE.setdefault("selectedVirtualId", "root")
                    STATE.setdefault("fileMeta", {})
                    STATE.setdefault("imports", [])
                    ensure_taxonomy_state(STATE)
                    ensure_links_and_theme_state(STATE)
                    STATE.setdefault("ui", {})
                    STATE["ui"].setdefault("sidebarWidth", 380)
                    STATE["ui"].setdefault("lastPhysicalFolderPath", "")
                    STATE["ui"].setdefault("lastVirtualFolderId", "root")
                    STATE["ui"].setdefault("linksCollapsed", False)
                    ensure_integration_state(STATE)
                    save_state()

                return self.send_json({"ok": True, "savedAt": now_iso()})

            if parsed.path == "/api/state/rollback":
                reason = str(payload.get("reason") or "before-external-integration")
                rollback = create_state_rollback(reason)
                return self.send_json({"ok": True, "rollback": rollback})

            if parsed.path == "/api/create":
                parent_path = str(payload.get("parentPath") or "")
                name = str(payload.get("name") or "").strip()
                kind = str(payload.get("kind") or "file")
                content = str(payload.get("content") or "")

                if not name or name in {".", ".."} or "/" in name or "\\" in name:
                    raise ValueError("Use a valid single folder or file name.")

                parent, _ = resolve_relative(parent_path)
                if not parent.is_dir():
                    raise NotADirectoryError("Parent path is not a folder.")

                target = (parent / name).resolve()
                root = configured_root()
                if Path(os.path.commonpath([str(root), str(target)])) != root:
                    raise PermissionError("New entry would be outside the workspace.")
                if target.exists():
                    raise FileExistsError(f'"{name}" already exists.')

                if kind == "folder":
                    target.mkdir()
                elif kind == "file":
                    if not is_text_extension(target):
                        raise ValueError("New in-app files must use a supported text extension such as .txt or .md.")
                    target.write_text(content, encoding="utf-8")
                else:
                    raise ValueError("Kind must be folder or file.")

                rel = target.relative_to(root).as_posix()
                return self.send_json({"ok": True, "entry": entry_info(target, rel)})

            if parsed.path == "/api/write":
                relative_path = str(payload.get("path") or "")
                content = str(payload.get("content") or "")
                target, normalized = resolve_relative(relative_path)

                if not target.exists() or not target.is_file():
                    raise FileNotFoundError("File was not found.")
                if not is_text_extension(target):
                    raise ValueError("This file type is preview-only and must be edited externally.")

                temp = target.with_name(target.name + ".eve-tmp")
                temp.write_text(content, encoding="utf-8")
                temp.replace(target)

                return self.send_json({
                    "ok": True,
                    "path": normalized,
                    "entry": entry_info(target, normalized),
                    "savedAt": now_iso(),
                })

            if parsed.path == "/api/rename":
                relative_path = str(payload.get("path") or "")
                new_name = str(payload.get("newName") or "").strip()

                if not new_name or new_name in {".", ".."} or "/" in new_name or "\\" in new_name:
                    raise ValueError("Use a valid single name.")

                target, normalized = resolve_relative(relative_path)
                if not target.exists():
                    raise FileNotFoundError("Entry was not found.")

                destination = target.with_name(new_name)
                root = configured_root()
                if Path(os.path.commonpath([str(root), str(destination.resolve())])) != root:
                    raise PermissionError("Destination is outside the workspace.")
                if destination.exists():
                    raise FileExistsError(f'"{new_name}" already exists.')

                target.rename(destination)
                new_rel = destination.resolve().relative_to(root).as_posix()

                with LOCK:
                    old_meta = dict(STATE.get("fileMeta", {}))
                    rewritten = {}
                    prefix = normalized.rstrip("/") + "/"

                    for key, value in old_meta.items():
                        if key == normalized:
                            rewritten[new_rel] = value
                        elif key.startswith(prefix):
                            suffix = key[len(prefix):]
                            rewritten[f"{new_rel}/{suffix}"] = value
                        else:
                            rewritten[key] = value

                    STATE["fileMeta"] = rewritten
                    save_state()

                return self.send_json({
                    "ok": True,
                    "oldPath": normalized,
                    "newPath": new_rel,
                    "entry": entry_info(destination, new_rel),
                })



            if parsed.path == "/api/copy-scope":
                source = str(payload.get("source") or "")
                mode = str(payload.get("mode") or "tree")
                style = str(payload.get("style") or "unicode")
                physical_path = str(payload.get("path") or "")
                virtual_id = str(payload.get("virtualId") or "root")
                result = build_copy_scope(
                    source=source,
                    mode=mode,
                    style=style,
                    physical_path=physical_path,
                    virtual_id=virtual_id,
                )
                return self.send_json({"ok": True, **result})

            if parsed.path == "/api/physical-to-virtual":
                relative_path = str(payload.get("path") or "")
                destination_virtual_id = str(payload.get("destinationVirtualId") or "root")
                result = copy_physical_to_worldbook(relative_path, destination_virtual_id)
                return self.send_json({
                    "ok": True,
                    **result,
                    "message": (
                        f'Copied "{result["node"]["name"]}" into the World Book '
                        f'with {result["entryCount"]:,} entries.'
                    ),
                })

            if parsed.path == "/api/virtual-to-zip":
                virtual_id = str(payload.get("virtualId") or "")
                destination_path = str(payload.get("destinationPath") or "")
                zip_name = str(payload.get("zipName") or "")

                if not virtual_id:
                    raise ValueError("A World Book entry must be selected.")

                result = export_virtual_to_live_zip(
                    virtual_id,
                    destination_path,
                    zip_name,
                )
                return self.send_json({
                    "ok": True,
                    **result,
                    "message": f'Created "{result["entry"]["name"]}" in Live Files.',
                })

            if parsed.path == "/api/open":
                relative_path = str(payload.get("path") or "")
                target, _ = resolve_relative(relative_path)
                if not target.exists():
                    raise FileNotFoundError("Entry was not found.")
                open_external(target)
                return self.send_json({"ok": True})

            if parsed.path == "/api/reveal":
                relative_path = str(payload.get("path") or "")
                target, _ = resolve_relative(relative_path)
                if not target.exists():
                    raise FileNotFoundError("Entry was not found.")
                reveal_external(target)
                return self.send_json({"ok": True})

            if parsed.path == "/api/import":
                snapshot = payload.get("snapshot")
                mode = str(payload.get("mode") or "archive")
                result = import_payload(snapshot, mode)
                return self.send_json({"ok": True, **result})

            return self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")

        except FileExistsError as exc:
            return self.send_error_json(HTTPStatus.CONFLICT, str(exc))
        except FileNotFoundError as exc:
            return self.send_error_json(HTTPStatus.NOT_FOUND, str(exc))
        except (ValueError, PermissionError, NotADirectoryError, json.JSONDecodeError) as exc:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            print(f"POST error: {exc}")
            return self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))

    def do_DELETE(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            if handle_narration_delete(self, parsed, query):
                return
            return self.send_error_json(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")
        except FileNotFoundError as exc:
            return self.send_error_json(HTTPStatus.NOT_FOUND, str(exc))
        except (ValueError, PermissionError) as exc:
            return self.send_error_json(HTTPStatus.BAD_REQUEST, str(exc))
        except Exception as exc:
            print(f"DELETE error: {exc}")
            return self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, str(exc))
