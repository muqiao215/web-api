from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, asdict
from typing import Any


HTTP_CHECKS = [
    ("sub2api", "http://127.0.0.1:18080/health"),
    ("gpt-web-api", "http://127.0.0.1:4242/health"),
    ("gpt-web-responses", "http://127.0.0.1:4252/health"),
    ("canvas-to-api", "http://127.0.0.1:7861/health"),
]

TCP_CHECKS = [
    ("chrome-cdp", "127.0.0.1", 9222),
    ("novnc", "127.0.0.1", 6080),
    ("ds-free-api", "127.0.0.1", 5317),
]

SYSTEMD_UNITS = [
    "sub2api-local.service",
    "gpt-web-api.service",
    "gpt-web-responses-shim.service",
    "canvas-to-api.service",
    "ds-free-api-b492dedd.service",
]


@dataclass
class CheckResult:
    kind: str
    name: str
    status: str
    detail: str


def http_json(url: str, timeout: float) -> tuple[dict[str, Any] | None, str | None]:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return None, str(exc)
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, f"non-json response: {raw[:120]}"


def check_http(timeout: float) -> list[CheckResult]:
    results: list[CheckResult] = []
    for name, url in HTTP_CHECKS:
        payload, error = http_json(url, timeout)
        if error:
            results.append(CheckResult("http", name, "FAIL", error))
            continue
        if name == "canvas-to-api" and payload and payload.get("browserConnected") is False:
            results.append(CheckResult("http", name, "WARN", "service ok but browserConnected=false"))
            continue
        results.append(CheckResult("http", name, "OK", summarize_payload(payload)))
    return results


def summarize_payload(payload: dict[str, Any] | None) -> str:
    if not payload:
        return "empty response"
    if "status" in payload:
        return f"status={payload['status']}"
    if "ok" in payload:
        return f"ok={payload['ok']}"
    return "json response"


def check_tcp(timeout: float) -> list[CheckResult]:
    results: list[CheckResult] = []
    for name, host, port in TCP_CHECKS:
        try:
            with socket.create_connection((host, port), timeout=timeout):
                results.append(CheckResult("tcp", name, "OK", f"{host}:{port} listening"))
        except OSError as exc:
            results.append(CheckResult("tcp", name, "FAIL", f"{host}:{port} {exc}"))
    return results


def check_systemd() -> list[CheckResult]:
    if not shutil_like_systemctl_available():
        return [CheckResult("systemd", "systemctl", "WARN", "systemctl not available")]
    results: list[CheckResult] = []
    for unit in SYSTEMD_UNITS:
        proc = subprocess.run(
            ["systemctl", "is-active", unit],
            check=False,
            capture_output=True,
            text=True,
        )
        state = proc.stdout.strip() or proc.stderr.strip()
        status = "OK" if state == "active" else "WARN"
        results.append(CheckResult("systemd", unit, status, state or "unknown"))
    return results


def shutil_like_systemctl_available() -> bool:
    try:
        proc = subprocess.run(["systemctl", "--version"], check=False, capture_output=True)
    except FileNotFoundError:
        return False
    return proc.returncode == 0


def print_text(results: list[CheckResult]) -> None:
    for result in results:
        print(f"{result.status:4} {result.kind:7} {result.name:32} {result.detail}")


def exit_code(results: list[CheckResult], strict: bool) -> int:
    if any(result.status == "FAIL" for result in results):
        return 1
    if strict and any(result.status == "WARN" for result in results):
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check local Web Capability API runtime health.")
    parser.add_argument("--strict", action="store_true", help="Treat WARN checks as failures.")
    parser.add_argument("--json", action="store_true", help="Print JSON results.")
    parser.add_argument("--timeout", type=float, default=2.0, help="Per-check timeout in seconds.")
    args = parser.parse_args(argv)

    results = []
    results.extend(check_systemd())
    results.extend(check_tcp(args.timeout))
    results.extend(check_http(args.timeout))

    if args.json:
        print(json.dumps([asdict(result) for result in results], ensure_ascii=False, indent=2))
    else:
        print_text(results)
    return exit_code(results, args.strict)


if __name__ == "__main__":
    sys.exit(main())
