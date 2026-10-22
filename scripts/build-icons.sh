#!/bin/sh
set -eu

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="file://$ROOT/icons/icon.svg"
FONT="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"

render() {
  width="$1"
  height="$2"
  out="$3"
  body="$4"
  page="$(mktemp -t quietest-asset).html"
  printf '<html><body style="margin:0;width:%spx;height:%spx">%s</body></html>' "$width" "$height" "$body" > "$page"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --force-device-scale-factor=1 --window-size="$width,$height" \
    --screenshot="$ROOT/$out" "file://$page" 2>/dev/null
  rm "$page"
}

promo() {
  width="$1"
  height="$2"
  out="$3"
  icon="$4"
  title="$5"
  tagline="$6"
  text="$7"
  render "$width" "$height" "$out" "<div style=\"box-sizing:border-box;width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:$((icon / 4))px;background:#0d1117;font-family:$FONT\"><img src=\"$SVG\" width=\"$icon\" height=\"$icon\"><div><div style=\"color:#ffffff;font-size:${title}px;font-weight:700;letter-spacing:-0.02em\">Quietest</div><div style=\"color:#9198a1;font-size:${tagline}px;margin-top:$((tagline / 2))px\">$text</div></div></div>"
}

mkdir -p "$ROOT/store"

for size in 16 32 48; do
  render "$size" "$size" "icons/$size.png" "<img src=\"$SVG\" width=\"$size\" height=\"$size\">"
done

# Chrome Web Store asks for 96x96 artwork inside a 128x128 canvas.
render 128 128 "icons/128.png" "<img src=\"$SVG\" width=\"96\" height=\"96\" style=\"margin:16px\">"

promo 440 280 "store/promo-small.png" 112 46 18 "The quietest diff."
promo 1400 560 "store/promo-marquee.png" 280 120 36 "The quietest diff. Tests muted until you ask."
