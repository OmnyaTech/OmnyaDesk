#!/usr/bin/env python3
"""Trusted S13 Ubuntu file helper. Never accepts arbitrary shell commands or absolute paths."""
import base64
import fcntl
import hashlib
import json
import os
import re
import stat
import sys

EXTENSIONS = (".md", ".txt", ".json", ".ts", ".tsx", ".js", ".css", ".html")
EXCLUDED = {"node_modules", "dist", ".git", ".ssh", ".env", ".github", "entry.sh"}
LIMIT = 16384
FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK

def validate_path(value, operation):
    if operation == "list" and value == ".":
        return []
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_./-]{1,190}", value):
        raise ValueError("PATH_DENIED")
    parts = value.split("/")
    if any((not p or p in (".", "..") or p.startswith(".") or
            p in EXCLUDED) for p in parts):
        raise ValueError("PATH_DENIED")
    if operation != "list" and not value.endswith(EXTENSIONS):
        raise ValueError("FILE_TYPE_DENIED")
    return parts

def owned_directory(root, segments):
    handle = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for part in segments:
            nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=handle)
            os.close(handle)
            handle = nxt
        return handle
    except BaseException:
        os.close(handle)
        raise

def current_file(parent, basename):
    try:
        fd = os.open(basename, FLAGS, dir_fd=parent)
    except FileNotFoundError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > LIMIT or st.st_nlink != 1:
            raise ValueError("FILE_UNSAFE_OR_TOO_LARGE")
        data = bytearray()
        while True:
            chunk = os.read(fd, 8192)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > LIMIT:
                raise ValueError("FILE_LIMIT")
        return bytes(data)
    finally:
        os.close(fd)

def execute():
    if len(sys.argv) < 4:
        raise ValueError("ARGS_DENIED")
    operation, root, rel = sys.argv[1:4]
    if operation not in ("list", "read", "write"):
        raise ValueError("OPERATION_DENIED")
    if not root.startswith("/home/") or "\x00" in root:
        raise ValueError("ROOT_DENIED")
    parts = validate_path(rel, operation)
    if operation == "list":
        parent = owned_directory(root, parts)
        try:
            names = sorted(os.listdir(parent))
            # Do not traverse symlinks; hide Git metadata, dotfiles and sensitive items.
            result = []
            for name in names:
                if name.startswith(".") or name in EXCLUDED or not re.fullmatch(r"[A-Za-z0-9_.-]{1,90}", name):
                    continue
                try:
                    st = os.stat(name, dir_fd=parent, follow_symlinks=False)
                except OSError:
                    continue
                if stat.S_ISDIR(st.st_mode):
                    result.append({"name": name, "kind": "dir"})
                elif stat.S_ISREG(st.st_mode):
                    result.append({"name": name, "kind": "file"})
                if len(result) >= 100:
                    break
            print(json.dumps({"entries": result}, separators=(",", ":")))
        finally:
            os.close(parent)
        return
    parent = owned_directory(root, parts[:-1])
    basename = parts[-1]
    try:
        # Serialize writers in the same directory across concurrent gateway processes.
        # Without flock two requests could both compare the old SHA before rename.
        if operation == "write":
            fcntl.flock(parent, fcntl.LOCK_EX)
        existing = current_file(parent, basename)
        if operation == "read":
            if existing is None:
                raise ValueError("FILE_NOT_FOUND")
            print(json.dumps({"text": existing.decode("utf-8", errors="strict"),
                              "sha256": hashlib.sha256(existing).hexdigest()}, separators=(",", ":")))
            return
        if len(sys.argv) != 6:
            raise ValueError("WRITE_ARGS_DENIED")
        expected = sys.argv[5]
        if expected != "absent" and not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise ValueError("EXPECTED_SHA_DENIED")
        actual = ("absent" if existing is None else hashlib.sha256(existing).hexdigest())
        if actual != expected:
            raise ValueError("FILE_STALE")
        encoded = sys.argv[4]
        if len(encoded) > 25000 or not re.fullmatch(r"[A-Za-z0-9+/=]+", encoded):
            raise ValueError("ENCODING_DENIED")
        content = base64.b64decode(encoded, validate=True)
        content.decode("utf-8", errors="strict")
        if len(content) > LIMIT:
            raise ValueError("FILE_LIMIT")
        temp = ".omnyadesk-" + os.urandom(12).hex()
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb") as file:
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.rename(temp, basename, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            try:
                os.unlink(temp, dir_fd=parent)
            except FileNotFoundError:
                pass
        print(json.dumps({"sha256": hashlib.sha256(content).hexdigest(),
                          "bytes": len(content)}, separators=(",", ":")))
    finally:
        os.close(parent)

try:
    execute()
except (ValueError, OSError, UnicodeError, PermissionError) as exc:
    # Error messages are classification labels, never include contents or host paths.
    label = exc.args[0] if isinstance(exc, ValueError) and exc.args else "ACCESS_DENIED"
    if not re.fullmatch(r"[A-Z_]{3,60}", str(label)):
        label = "ACCESS_DENIED"
    sys.stderr.write(label + "\n")
    sys.exit(73)
