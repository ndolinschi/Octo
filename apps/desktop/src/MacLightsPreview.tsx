import { MAC_LIGHT_PITCH, MAC_LIGHT_SIZE, MAC_LIGHTS_CENTER_OFFSET, MAC_LIGHTS_X, MAC_LIGHTS_Y } from "./windowChrome";

const COLOURS = ["#ff5f57", "#febc2e", "#28c840"];

/**
 * Dev only (`?titlebar=mac`): three placeholder discs where the macOS traffic lights would be, from the same constants as
 * `trafficLightPosition` in `tauri.macos.conf.json` (x = the first light's left edge, centre = y + the version's offset). Not in production builds.
 */
export default function MacLightsPreview() {
  const top = MAC_LIGHTS_Y + MAC_LIGHTS_CENTER_OFFSET - MAC_LIGHT_SIZE / 2;
  return (
    <div aria-hidden data-mac-lights className="pointer-events-none fixed inset-0 z-50">
      {COLOURS.map((c, i) => (
        <span
          key={c}
          data-mac-light={i}
          className="absolute rounded-full"
          style={{ left: MAC_LIGHTS_X + i * MAC_LIGHT_PITCH, top, width: MAC_LIGHT_SIZE, height: MAC_LIGHT_SIZE, background: c }}
        />
      ))}
    </div>
  );
}
