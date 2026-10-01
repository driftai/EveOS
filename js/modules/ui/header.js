// --- READOUT / HEADER ---

const HEADER_EFFECT_CLASSES = [
    "hc-effect-rainbow",
    "hc-effect-glow",
    "hc-effect-bounce",
    "hc-effect-wave",
    "hc-effect-fade",
    "hc-effect-shake",
    "hc-effect-neon",
    "hc-effect-glitch"
];

const FALLBACK_HEADER_SETTINGS = {
    showDate: true,
    use24HourClock: false,
    includeName: true,
    morningMessage: "Good Morning",
    afternoonMessage: "Good Afternoon",
    eveningMessage: "Good Evening",
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: 56,
    letterSpacing: 2,
    textColor: "",
    effect: "none",
    effectColor: "#00d4ff"
};

function getHeaderSettings() {
    const stateApi = window.EveOS?.HeaderControls?.State;
    if (stateApi?.ensureConfigBucket) return stateApi.ensureConfigBucket();
    return { ...FALLBACK_HEADER_SETTINGS };
}

function resolveGreetingText(now, settings) {
    const hour = now.getHours();
    let greetingText = settings.morningMessage || "Good Morning";
    if (hour >= 12) greetingText = settings.afternoonMessage || "Good Afternoon";
    if (hour >= 18) greetingText = settings.eveningMessage || "Good Evening";

    if (settings.includeName && config.userName) {
        greetingText = greetingText.includes("{name}")
            ? greetingText.replaceAll("{name}", config.userName)
            : `${greetingText}, ${config.userName}`;
    } else {
        greetingText = greetingText.replaceAll("{name}", "").trim();
    }

    return greetingText;
}

function applyHeaderStyles(display, settings) {
    const mode = config.headerMode === "clock" ? "clock" : "greeting";
    display.style.fontFamily = mode === "clock" ? "monospace" : settings.fontFamily;
    display.style.fontSize = `${settings.fontSize}px`;
    display.style.letterSpacing = `${settings.letterSpacing}px`;
    display.style.color = settings.textColor || "var(--accent)";
    display.style.setProperty("--header-effect-color", settings.effectColor || settings.textColor || "#00d4ff");

    const desiredClass = settings.effect && settings.effect !== "none"
        ? `hc-effect-${settings.effect}`
        : "";

    HEADER_EFFECT_CLASSES.forEach(effectClass => {
        if (effectClass !== desiredClass) display.classList.remove(effectClass);
    });
    if (desiredClass) {
        display.classList.add(desiredClass);
    }
}

function updateDateArea(now, settings) {
    const dateArea = document.getElementById("date-area");
    if (!dateArea) return;

    if (settings.showDate === false) {
        dateArea.innerText = "";
        dateArea.style.display = "none";
        return;
    }

    dateArea.style.display = "";
    dateArea.innerText = now.toLocaleDateString([], {
        weekday: "long",
        month: "long",
        day: "numeric"
    });
}

function updateTimeAndGreeting() {
    const now = new Date();
    const display = document.getElementById("main-display");
    if (!display) return;

    const settings = getHeaderSettings();
    const timeText = now.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: !settings.use24HourClock
    });

    if (config.headerMode === "clock") {
        display.innerText = timeText;
    } else {
        display.innerText = resolveGreetingText(now, settings);
    }

    applyHeaderStyles(display, settings);
    updateDateArea(now, settings);
}

function toggleHeaderMode() {
    config.headerMode = config.headerMode === "greeting" ? "clock" : "greeting";
    saveConfig();
    updateTimeAndGreeting();
}

function installTopbarWheelScroll() {
    if (document.documentElement.dataset.topbarWheelScrollBound === "1") return;
    document.documentElement.dataset.topbarWheelScrollBound = "1";

    document.addEventListener("wheel", event => {
        if (event.ctrlKey || event.metaKey) return;
        const target = event.target instanceof Element ? event.target : null;
        const strip = target?.closest?.(".top-right");
        if (!strip) return;

        const maxScroll = strip.scrollWidth - strip.clientWidth;
        if (maxScroll <= 1) return;

        const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
            ? event.deltaX
            : event.deltaY;
        if (!delta) return;

        strip.scrollLeft = Math.max(0, Math.min(maxScroll, strip.scrollLeft + delta));
        // While the pointer is over the horizontal action strip, wheel input
        // belongs to that strip. Do not let it fall through and move the page,
        // even when the strip is already at one of its ends.
        event.preventDefault();
    }, { passive: false, capture: true });
}

installTopbarWheelScroll();

