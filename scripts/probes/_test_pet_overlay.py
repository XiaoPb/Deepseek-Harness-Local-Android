#!/usr/bin/env python3
"""Static regression checks for the optional, plugin-driven desktop pet overlay.

No Android device is required. These checks protect the design decisions that are
easy to undo by accident:

  * the pet overlay is a real TYPE_APPLICATION_OVERLAY foreground service, not a
    second accessibility overlay;
  * the bridge receiver binds loopback only and stays bounded;
  * the five real dsh-pet-bridge fields are parsed (not a made-up type/phase schema);
  * animation packs are user-imported, never bundled;
  * settings reach the feature without touching the existing StatusOverlay;
  * the bridge plugin is discoverable but not installed by the app.

Run: python scripts/probes/_test_pet_overlay.py
Exit code 0 = all checks passed.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
APP = os.path.join(ROOT, "app", "src", "main")
JAVA = os.path.join(APP, "java", "app", "dsh", "mobile")
PET = os.path.join(JAVA, "pet")
RES = os.path.join(APP, "res")
DOCS = os.path.join(ROOT, "docs", "PET_OVERLAY.md")

FAILS = []


def check(name, ok, detail=""):
    if ok:
        print("PASS  " + name)
    else:
        print("FAIL  " + name + (("  -> " + detail) if detail else ""))
        FAILS.append(name)


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def exists(path):
    return os.path.isfile(path)


def has(path, *needles):
    if not exists(path):
        return False
    text = read(path)
    return all(n in text for n in needles)


# ---------------------------------------------------------------- manifest
manifest = read(os.path.join(APP, "AndroidManifest.xml"))
check("manifest: SYSTEM_ALERT_WINDOW permission", "android.permission.SYSTEM_ALERT_WINDOW" in manifest)
check("manifest: pet service declared", ".pet.PetOverlayService" in manifest)
check("manifest: pet service is specialUse", "floating_desktop_pet" in manifest and "foregroundServiceType=\"specialUse\"" in manifest)
check("manifest: pet service not exported", re.search(
    r'android:name="\.pet\.PetOverlayService"[\s\S]{0,200}?android:exported="false"', manifest) is not None)
check("manifest: pet settings activity declared", ".pet.PetSettingsActivity" in manifest)
check("manifest: pet settings activity not exported", re.search(
    r'android:name="\.pet\.PetSettingsActivity"[\s\S]{0,200}?android:exported="false"', manifest) is not None)

# ---------------------------------------------------------------- files
for name in [
    "PetProtocol.kt", "PetBridgeServer.kt", "PetActionController.kt", "PetView.kt",
    "PetPhysics.kt", "PetPack.kt", "PetPackInstaller.kt", "PetOverlayService.kt",
    "PetActionMenu.kt", "PetSettingsActivity.kt", "PetPrefs.kt", "PetPluginDetector.kt",
    "PetStatus.kt",
]:
    check("pet file: " + name, exists(os.path.join(PET, name)))

check("layout: activity_pet.xml", exists(os.path.join(RES, "layout", "activity_pet.xml")))
check("drawable: ic_pet.xml", exists(os.path.join(RES, "drawable", "ic_pet.xml")))
check("docs: PET_OVERLAY.md", exists(DOCS))
check("docs: explains bridge + port + import + license",
      exists(DOCS) and all(k in read(DOCS) for k in
                           ("dsh-pet-bridge", "7779", "pet-config.json", "non-commercial")))

# ---------------------------------------------------------------- protocol
protocol = read(os.path.join(PET, "PetProtocol.kt"))
for field in ("kind", "agent_source", "tool_name", "tool_input", "caller_pid"):
    check("protocol: " + field, '"' + field + '"' in protocol)
for kind in ("user", "pre", "post", "stop"):
    check("protocol: kind " + kind, '"' + kind + '"' in protocol)
for key in ("file_path", "command", "pattern", "query"):
    check("protocol: tool_input key " + key, '"' + key + '"' in protocol)
check("protocol: body size limit", "MAX_BODY_BYTES" in protocol)
check("protocol: sanitizer strips control chars", "u202A" in protocol or "202A" in protocol)
check("protocol: summary truncation", "takeCodePoints" in protocol)

# ---------------------------------------------------------------- receiver
server = read(os.path.join(PET, "PetBridgeServer.kt"))
check("receiver: loopback bind", 'getByName("127.0.0.1")' in server)
check("receiver: never binds all interfaces", '"0.0.0.0"' not in server)
check("receiver: bounded body", "MAX_BODY_BYTES" in server)
check("receiver: socket timeout", "SOCKET_TIMEOUT_MS" in server)
check("receiver: POST /bubble route", '"/bubble"' in server)
check("receiver: ping route", '"/ping"' in server)
# v1.4.21（PR #48 评审）：/bubble 必须 token 门控，fail-closed
check("receiver: token header defined", '"X-DSH-Pet-Token"' in protocol)
check("receiver: /bubble token gate", "authorised(headerLines)" in server)
check("receiver: token fail-closed 403", 'respond(output, 403, "Forbidden")' in server)
check("receiver: per-process token", "currentToken(): String" in server)
engine_cfg = read(os.path.join(ROOT, "app/src/main/java/app/dsh/mobile/engine/EngineConfig.kt"))
check("receiver: token to engine env", "DSH_PET_BRIDGE_TOKEN=${PetBridgeServer.currentToken()}" in engine_cfg)

# ---------------------------------------------------------------- controller/mapping
controller = read(os.path.join(PET, "PetActionController.kt"))
for slug in ("a055", "a052", "a054", "a056", "a057", "a053"):
    check("mapping: " + slug, slug in controller or slug in read(os.path.join(PET, "PetPack.kt")))
check("controller: ack hold", "ACK_HOLD_MS" in controller)
check("controller: stop grace", "STOP_GRACE_MS" in controller)
check("controller: engine watchdog", "onTick" in controller and "engineRunning" in controller)
check("controller: no fabricated post filename", "step_done" in controller)

# ---------------------------------------------------------------- service
svc = read(os.path.join(PET, "PetOverlayService.kt"))
check("service: TYPE_APPLICATION_OVERLAY", "TYPE_APPLICATION_OVERLAY" in svc)
check("service: not accessibility overlay", "TYPE_ACCESSIBILITY_OVERLAY" not in svc)
check("service: foreground service type", "FOREGROUND_SERVICE_TYPE_SPECIAL_USE" in svc)
check("service: overlay permission check", "Settings.canDrawOverlays" in svc)
check("service: notification channel", "CHANNEL_ID" in svc and "createNotificationChannel" in svc)
check("service: stop action", "ACTION_STOP" in svc)
check("service: sticky only when enabled", "START_STICKY" in svc)
check("service: restore helper", "restoreIfEnabled" in svc)
check("service: test bubble helper", "showTestBubble" in svc)
check("service: bubble is not touchable", "FLAG_NOT_TOUCHABLE" in svc)

# ---------------------------------------------------------------- renderer
view = read(os.path.join(PET, "PetView.kt"))
check("renderer: API 28 AnimatedImageDrawable", "AnimatedImageDrawable" in view)
check("renderer: API 28 guard", "Build.VERSION.SDK_INT >= 28" in view)
check("renderer: API 26/27 Movie fallback", "Movie.decodeStream" in view)
check("renderer: built-in placeholder", "drawPlaceholder" in view)
check("renderer: no bundled animation asset lookup", "assets/webp" not in view)

# ---------------------------------------------------------------- physics/attribution
physics = read(os.path.join(PET, "PetPhysics.kt"))
check("physics: gravity constant", "GRAVITY = 1400.0" in physics)
check("physics: restitution constant", "RESTITUTION = 0.78" in physics)
check("physics: dsh-pet-android attribution", "dsh-pet-android" in physics)
check("notice file exists", exists(os.path.join(ROOT, "NOTICE")))

# ---------------------------------------------------------------- pack import
installer = read(os.path.join(PET, "PetPackInstaller.kt"))
check("pack: traversal guard", ".." in installer and "safeName" in installer)
check("pack: entry cap", "MAX_ENTRIES" in installer)
check("pack: total cap", "MAX_TOTAL_BYTES" in installer)
check("pack: free-space check", "StatFs" in installer and "availableBytes" in installer)
check("pack: temp + atomic replace", "pack.tmp" in installer and "renameTo" in installer)
check("pack: only webp/config extracted", "isWebpEntry" in installer and "pet-config.json" in installer)
check("pack: no assets/pet directory in APK", not any(
    n.endswith(".webp") for _, _, names in os.walk(os.path.join(APP, "assets")) for n in names))

# ---------------------------------------------------------------- settings + hooks
settings = read(os.path.join(JAVA, "SettingsActivity.kt"))
layout = read(os.path.join(RES, "layout", "activity_settings.xml"))
check("settings: rowPet handler", "rowPet" in settings and "PetSettingsActivity" in settings)
check("settings: refreshPetRow", "refreshPetRow()" in settings)
check("settings layout: rowPet", "rowPet" in layout and "valPet" in layout)
pet_settings = read(os.path.join(PET, "PetSettingsActivity.kt"))
check("pet settings: overlay permission action", "ACTION_MANAGE_OVERLAY_PERMISSION" in pet_settings)
check("pet settings: plugin store shortcut", "EXTRA_QUERY" in pet_settings)
check("pet settings: pack import", "PetPackInstaller.install" in pet_settings)
check("pet settings: size picker", "pet_size_value" in pet_settings)
check("pet settings: responsive orientation", "OrientationPrefs.applyTo(this)" in pet_settings)
check("pet settings: max width", "MaxWidthLinearLayout" in pet_settings)

main = read(os.path.join(JAVA, "MainActivity.kt"))
check("lifecycle: restore on MainActivity resume", "PetOverlayService.restoreIfEnabled" in main)
engine = read(os.path.join(JAVA, "service", "EngineService.kt"))
check("lifecycle: stop on explicit engine exit", "PetOverlayService.stop" in engine)

# ---------------------------------------------------------------- discovery
center = read(os.path.join(JAVA, "engine", "PluginCenter.kt"))
catalog = read(os.path.join(ROOT, "community-plugins.json"))
check("catalog: dsh-pet-bridge in builtin", "dsh-pet-bridge" in center)
check("catalog: dsh-pet-bridge in JSON", "dsh-pet-bridge" in catalog)
check("catalog: bridge not bundled", not os.path.isdir(os.path.join(APP, "assets", "android-plugins", "pet")))

# ---------------------------------------------------------------- strings
for loc in ("values", "values-zh-rCN", "values-de"):
    strings = read(os.path.join(RES, loc, "strings.xml"))
    for key in (
        "setting_pet", "pet_title", "pet_enable", "pet_permission",
        "pet_plugin", "pet_pack", "pet_pack_import", "pet_bubble_thinking",
        "pet_notif_title", "pet_error_port_busy",
    ):
        check("%s: %s" % (loc, key), 'name="%s"' % key in strings)

# ---------------------------------------------------------------- result
if FAILS:
    print("\nFAILED %d check(s)" % len(FAILS))
    sys.exit(1)
print("\nOK: pet overlay checks passed")
