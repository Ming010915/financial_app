#!/usr/bin/env bash
set -e

cleanup() {
    echo ""
    echo "Shutting down..."
    kill "$APP_PID" 2>/dev/null || true
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

echo "App running (PID $APP_PID). Starting localtunnel on port 5000..."

# Run lt and capture its output line by line until we find the URL
TUNNEL_URL=""
while IFS= read -r line; do
    echo "$line"
    if [[ "$line" =~ https?://[a-zA-Z0-9._/-]+ ]]; then
        TUNNEL_URL="${BASH_REMATCH[0]}"
        break
    fi
done < <(lt --port 5000 2>&1)

if [[ -z "$TUNNEL_URL" ]]; then
    echo "Error: could not extract URL from localtunnel output." >&2
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
