def main() -> None:
    parser = argparse.ArgumentParser(description="Run World Book locally.")
    parser.add_argument("--port", type=int, default=int(CONFIG.get("port") or 8766))
    parser.add_argument("--host", choices=("127.0.0.1", "0.0.0.0"), default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMPORTS_DIR.mkdir(parents=True, exist_ok=True)
    RECOVERY_UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    RECOVERY_ROLLBACKS_DIR.mkdir(parents=True, exist_ok=True)
    RECOVERY_TEMP_DIR.mkdir(parents=True, exist_ok=True)
    NARRATION_DOCUMENTS_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_recovery_staging()
    mimetypes.add_type("application/javascript", ".js")

    host = args.host
    port = args.port
    CONFIG["port"] = port
    save_config()

    server = ThreadingHTTPServer((host, port), WorldBookHandler)
    browser_host = "127.0.0.1" if host == "0.0.0.0" else host
    url = f"http://{browser_host}:{port}/"

    print()
    print("World Book")
    print(f"Running at {url}")
    if host == "127.0.0.1":
        print("Exposure: LOCALHOST only. Other devices cannot connect directly.")
    else:
        print("Exposure: LAN. Devices on this local network can connect to this port.")
    print("Press Ctrl+C to stop.")
    print()

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()

    restore_world_portal_desired_state_async()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping World Book...")
    finally:
        stop_world_portal(persist=False)
        server.server_close()


if __name__ == "__main__":
    main()
