#!/usr/bin/env bash
set -e

TUNNEL_LOG="$(mktemp -t tunnel.XXXXXX.log)"
cleanup() {
    echo ""
    echo "Shutting down..."
    kill "$APP_PID" 2>/dev/null || true
    kill "$TUNNEL_PID" 2>/dev/null || true
    # Also stop any other child processes (belt and braces).
    pkill -P $$ 2>/dev/null || true
    rm -f "$TUNNEL_LOG" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start the Flask app in the background
echo "Starting python app.py..."
python app.py &
APP_PID=$!

# Give the app a moment to bind to the port
sleep 2

# Check the app actually started
if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "Error: app.py failed to start." >&2
    exit 1
fi

echo "App running (PID $APP_PID). Starting tunnel on port 5000..."

# Run the tunnel in the background with its output going to a log file, then
# poll the log for the URL. This keeps the tunnel's stdout drained the whole
# time it runs -- crucial for cloudflared, which logs continuously; if its
# output pipe ever fills up the process stalls/dies and you get Error 1033.
# $1 = regex matching the expected tunnel host (cloudflared also prints other
# URLs first, e.g. its terms-of-use link, so we can't just grab any URL).
TUNNEL_URL=""
wait_for_tunnel_url() {
    local pattern="$1"
    for _ in $(seq 1 30); do  # up to ~30s
        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
            echo "Error: tunnel process exited early. Log:" >&2
            cat "$TUNNEL_LOG" >&2
            return 1
        fi
        if [[ "$(cat "$TUNNEL_LOG")" =~ $pattern ]]; then
            TUNNEL_URL="${BASH_REMATCH[0]}"
            return 0
        fi
        sleep 1
    done
    return 1
}

# Tunnel selection. Default to localtunnel (lt) because its --subdomain gives a
# FIXED URL (https://$LT_SUBDOMAIN.loca.lt) across runs. cloudflared quick
# tunnels have no reminder page but the URL is random every time.
# Override with: TUNNEL=cloudflared ./run_and_share.sh
TUNNEL="${TUNNEL:-lt}"
SUBDOMAIN="${LT_SUBDOMAIN:-myfloapp-tum}"

if [[ "$TUNNEL" == "lt" ]] && command -v lt &>/dev/null; then
    echo "Using localtunnel with fixed subdomain: $SUBDOMAIN"
    echo "Note: browser visitors may see localtunnel's reminder page once per IP / 7 days."
    lt --port 5000 --subdomain "$SUBDOMAIN" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    wait_for_tunnel_url 'https://[a-zA-Z0-9._-]+\.loca\.lt'
elif command -v cloudflared &>/dev/null; then
    [[ "$TUNNEL" == "lt" ]] && echo "lt not found; falling back to cloudflared (random URL)."
    echo "Using cloudflared quick tunnel (URL changes each run)..."
    cloudflared tunnel --url http://localhost:5000 --no-autoupdate > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    wait_for_tunnel_url 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com'
elif command -v lt &>/dev/null; then
    echo "Using localtunnel with fixed subdomain: $SUBDOMAIN"
    echo "Note: browser visitors may see localtunnel's reminder page once per IP / 7 days."
    lt --port 5000 --subdomain "$SUBDOMAIN" > "$TUNNEL_LOG" 2>&1 &
    TUNNEL_PID=$!
    wait_for_tunnel_url 'https://[a-zA-Z0-9._-]+\.loca\.lt'
else
    echo "Error: no tunnel tool found. Install one of:" >&2
    echo "  lt           (npm install -g localtunnel)  -- fixed URL via --subdomain" >&2
    echo "  cloudflared  (random URL, no reminder page)" >&2
    exit 1
fi

if [[ -z "$TUNNEL_URL" ]]; then
    echo "Error: could not extract URL from tunnel output. Log:" >&2
    cat "$TUNNEL_LOG" >&2
    exit 1
fi

echo ""
echo "Tunnel URL: $TUNNEL_URL"
echo ""

# Generate and display the QR code in the terminal.
# Tries qrencode first, falls back to a Python one-liner.
if command -v qrencode &>/dev/null; then
    qrencode -t UTF8 "$TUNNEL_URL"
elif python3 -c "import qrcode" 2>/dev/null; then
    python3 - "$TUNNEL_URL" <<'PYEOF'
import sys, qrcode
qr = qrcode.QRCode(border=1)
qr.add_data(sys.argv[1])
qr.make(fit=True)
qr.print_ascii(invert=True)
PYEOF
else
    echo "No QR tool found. Install one of:"
    echo "  sudo apt install qrencode"
    echo "  pip install qrcode[pil]"
    exit 1
fi

echo ""
echo "Press Ctrl+C to stop."

# Keep the script alive so the tunnel and app stay running
wait "$APP_PID"
