// Buy Me a Coffee support button. Uses BMC's official button-image API (rather
// than their runtime widget <script>) so it's a single self-contained link:
// reliable, degrades gracefully offline, and — as a target="_blank" link — opens
// in the system browser (Tauri v2 routes external _blank links externally).

const BMC_URL = "https://www.buymeacoffee.com/trailbrake";
const BMC_IMG =
  "https://img.buymeacoffee.com/button-api/?text=Buy%20me%20a%20coffee&emoji=%E2%98%95&slug=trailbrake" +
  "&button_colour=5F7FFF&font_colour=ffffff&font_family=Cookie&outline_colour=000000&coffee_colour=FFDD00";

export function BuyMeACoffee() {
  return (
    <a href={BMC_URL} target="_blank" rel="noreferrer noopener" title="Support Trailbrake on Buy Me a Coffee">
      <img src={BMC_IMG} alt="Buy me a coffee" style={{ height: 44, display: "block", borderRadius: 10 }} />
    </a>
  );
}
