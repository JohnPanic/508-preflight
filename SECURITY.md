# Security and deployment boundary

This is a hardened local prototype, not an approved public deployment. Do not expose the Node process directly to the internet.

## Review findings and application controls

The original DNS check followed by `route.continue()` had a time-of-check/time-of-use gap: Chromium could resolve a different address after validation. Playwright also may route only the first request in a redirect chain. The scanner now combines two layers:

1. Routed HTTP/HTTPS requests validate all DNS answers and use a Node connection pinned to a checked IP. The original Host header and TLS hostname/certificate verification remain in place. Compressed and decoded responses are bounded.
2. Chromium uses a fresh loopback egress proxy. Every HTTP destination and HTTPS CONNECT tunnel is independently validated and connected to a checked IP. This covers redirect connections that do not re-enter the Playwright route handler. HTTPS remains end-to-end encrypted; the proxy does not decrypt TLS or bypass certificate errors.

Both reject non-public IPv4/IPv6, mapped private IPv4, alternative numeric loopback encodings, cloud link-local/ULA metadata addresses, Azure's `168.63.129.16` platform address, credentials in URLs, non-HTTP protocols, and destination ports other than 80/443. Any private answer in a mixed DNS response rejects the hostname. DNS lookups have a three-second deadline. Service workers and WebSockets are blocked; non-proxied WebRTC UDP is disabled by a Chromium flag. Popups are closed. These restrictions may make some dynamic pages unavailable to the scanner; they do not change the axe rule set or label a blocked scan as compliant.

Scanning, HTML generation, and PDF generation share a single operation slot with no unbounded queue. Each operation runs in a separate worker with a 256 MB V8 heap ceiling and a minimal environment without service secrets or proxy credentials. Browser launch is limited to 15 seconds. The parent enforces a 60-second scan or 30-second export deadline covering launch, rendering, evaluation, and cleanup. Client disconnects and shutdown cancel work. Normal completion closes Chromium; cancellation/deadline kills the worker process tree (Windows taskkill; POSIX process group) before accepting another operation.

IP quotas: five scan attempts per ten minutes and twenty export attempts per ten minutes. Both export formats share a quota; invalid requests count. IPv4-mapped addresses normalize to IPv4 and IPv6 clients share a /64 key. In-memory rate stores are capped at 10,000 keys and fail closed on saturation. Rate limits reset after process restart and are per instance. Requests receive HTTP 429 and Retry-After when limited. Arbitrary X-Forwarded-For headers are ignored (`trust proxy` is false).

API protections include same-origin browser requests only, no CORS permission, 4 KB scan bodies, 20 MB export bodies, rejection of compressed request bodies, 16 KB headers, body/header deadlines, 100 incoming connections, safe JSON errors, CSP, nosniff, frame denial, and no-store responses. A client disconnect never frees the browser slot before worker cleanup.

Network/resource budgets per scan:

Generated downloads are capped at 40 MB. Export payload and generated-download limits fail the operation instead of removing evidence.

- At most 400 intercepted requests and 20 in-flight routed requests.
- At most 5 MB compressed or decoded bytes per routed response; 40 MB total decoded routed responses.
- Proxy fallback: 400 HTTP requests/CONNECT tunnels, 20 simultaneous upstream connections, 10 MB per response/tunnel and 40 MB total received bytes. TLS bytes are encrypted, so this layer cannot inspect decoded sizes; browser memory needs an OS limit.
- At most 1 MB per routed/HTTP proxy request body; ten redirects observed by Playwright responses. Browser-native redirect limits also apply. TLS tunnel uploads cannot be inspected by the proxy.
- At most 50,000 DOM elements before axe. Result JSON is capped at 20 MB. Export trees are capped at 100,000 nodes, depth 30, and generated HTML at 40 MB.

Over-limit operations fail; evidence is not truncated to create a successful report. PDF/HTML formatting and scan rule selection remain unchanged. HTML remains escaped and allowlisted, with no executable scanned markup. PDF runs with JavaScript disabled and network routes blocked.

## Required hosting-level isolation

Chromium runs through a loopback-only Playwright control endpoint with a randomly generated path; its address is never sent to report clients. Treat this endpoint as privileged and keep it isolated alongside the egress proxy. The parent records Chromium's PID separately, allowing cleanup when the Node worker unexpectedly exits before normal browser close.

Application validation is not a substitute for a network firewall or a browser sandbox.

1. Run browser workers as a non-root user in a dedicated container/network namespace with Chromium sandbox support, seccomp/AppArmor, a read-only root filesystem, a small ephemeral working directory, no host mounts, no Docker socket, and no cloud credentials or workload identity. Linux launches request the Chromium sandbox; configure the host to support it rather than turning it off.
2. Apply explicit OS/container CPU, resident-memory, PID, ephemeral-disk, and file-descriptor limits. The 256 MB setting limits only Node's V8 heap, not Chromium or native allocations. Start with measured workload limits (for example one CPU, 1 GB total memory, 128 PIDs, 256 MB scratch storage) and tune using load tests. Use a supervisor/container runtime that kills the entire cgroup/job on crash, OOM, timeout, or shutdown. POSIX process groups do not catch descendants that deliberately create a new session.
3. Enforce default-deny egress outside the browser process. Browser traffic should reach only an approved egress proxy; the trusted proxy may reach public TCP 80/443 and approved DNS resolvers. Reject loopback/internal routes except the explicit proxy socket, private/reserved IPv4 and IPv6 ranges, link-local, VPC/service networks, metadata/platform IPs, multicast, and internal public-addressed networks. Disable cloud metadata access/identity on the worker. Disable IPv6 entirely if equivalent IPv6 firewall policy is unavailable. Do not depend on a Chromium flag alone to prevent direct UDP, DNS, QUIC, WebRTC, or a compromised browser from bypassing the proxy.
4. Keep the loopback scan proxy internal to its worker. The current app and proxy run locally; stronger deployment isolation should separate the browser network namespace from the trusted proxy, since shared-namespace firewall rules cannot distinguish loopback services safely. Never expose the ephemeral proxy port as a public/open proxy.
5. Put the application behind a TLS reverse proxy with authentication or equivalent abuse controls, request/body/connection limits, upload timeouts, and edge IP quotas. Currently the server binds only to 127.0.0.1. Proxy-origin handling must be configured for the actual deployment: the default same-origin comparison assumes direct HTTP. Do not enable blanket `trust proxy: true`. Configure only the known proxy hops/CIDRs and ensure the edge overwrites client-address headers. Until then, app-level quotas intentionally treat a reverse proxy as one client; enforce real-client quotas at the edge. Use a shared rate-limit store and global worker capacity control when running multiple instances.
6. Restrict inbound Host names at the edge to your chosen domain, prevent direct origin access and DNS-rebinding access to local services, and terminate TLS. Keep Node, Playwright/browser binaries and dependencies patched; monitor denied egress, rate limits, worker crashes, memory, and timeouts without logging scanned content or secrets.
7. Re-test the actual firewall and sandbox with private/cloud metadata redirects, IPv6, rebinding DNS, WebSockets, service workers, slow pages, compression bombs, and worker OOM/CPU loops. Run an independent security review before public exposure. Only Windows process-tree cleanup and the current local runtime are exercised here; Linux process-group and sandbox behavior need deployment-environment verification.

## Tests

Implementation references: [Playwright routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route), [BrowserServer lifecycle](https://playwright.dev/docs/api/class-browserserver), and [Node HTTP server limits](https://nodejs.org/api/http.html).

`npm test` includes SSRF address policy, mixed DNS answers, pinned sockets, redirect fallback, WebSocket blocking, proxy HTTP/CONNECT denials, decompression/timeout budgets, IP quota normalization and saturation, spoofed forwarding headers, request sizes, origin checks, shared operation capacity, disconnect cancellation, export tree bounds, and hard worker/descendant cleanup. `node test/ui-check.js` and `node test/export-check.js` verify the real rendered scan and unchanged report interface/exports against example.com. Generated test fixtures and reports remain ignored.
