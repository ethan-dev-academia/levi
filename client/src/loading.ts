/**
 * The loading screen: a page from the Archive (a picture of the world and a
 * bit of its lore), a tip, and a bar that follows the real boot. Runs before
 * the game's own code, so it's up while everything else downloads.
 */

interface Lore {
  image: string;
  title: string;
  text: string;
}

const LORE: readonly Lore[] = [
  {
    image: "landing",
    title: "Falcon's Landing",
    text: "An island adrift high above the clouds, and the first shore every hero sees. The Benefactor sends them here to wake, to learn, and to be looked over by Falcon before the world below is told their names.",
  },
  {
    image: "edge",
    title: "Above the Clouds",
    text: "Nobody remembers who set the Landing afloat. The townsfolk say the Benefactor lifted it from the Layland with one hand so his heroes would never begin their lives in the dirt. Don't lean too far over the edge.",
  },
  {
    image: "lookout",
    title: "Falcon's Watch",
    text: "Falcon climbs his tower every evening and stares at the horizon for a long while. Ask him what he's looking for and he'll tell you it's the weather. It is never the weather.",
  },
  {
    image: "training",
    title: "The Training Grounds",
    text: "Sword, bow or light. The Grounds don't care which you choose, only that you choose. The dummies have been beaten by every hero in living memory and have not complained once.",
  },
  {
    image: "falcon",
    title: "Falcon",
    text: "Warden of the Landing. Teacher of every hero for longer than the Archive has kept records, which is strange, since he looks no older than thirty. He keeps more secrets than arrows.",
  },
  {
    image: "cathedral",
    title: "The Grand Cathedral",
    text: "Seat of the Benefactor in the Layland. Heroes who fall in battle wake on its altar, whole again. The sisters say this is a gift. The Archive notes that no one has ever asked for the price.",
  },
  {
    image: "arena",
    title: "The Seven Emperors",
    text: "Eta, Zeta, Epsilon, Delta, Gamma, Beta and Alpha. Small, swift and terrible, each a master of sword, bow and spell alike. Every age has its Emperors. The Archive has never recorded one dying of old age.",
  },
  {
    image: "mountain",
    title: "The Ley Lines",
    text: "Long ago the Benefactor drew lines of power across the Layland, and the land settled along them like iron filings to a lodestone. Every region, every city, every old road follows a line he drew.",
  },
];

const TIPS: readonly string[] = [
  "Right-click the ground to walk. Hold it to keep walking.",
  "Your weapon decides your style: swords and daggers for Brawlers, bows and guns for Rangers, staves and wands for Mages.",
  "Click an objective in the quest tracker to see it on the world map.",
  "A gold ! over someone's head means they have a quest for you. A ? means they're waiting on you.",
  "Press M for the world map. Regions light up as you discover them.",
  "Your newest quest pins itself to the tracker. Pin or unpin quests from the journal.",
  "If you fall in battle you wake at the nearest Cathedral, unharmed.",
  "Press N to turn the sound on or off.",
  "Skills are bound to Q, W, E and R. Open the Skills tab to choose them.",
  "Townsfolk have plenty to say. Walk close and listen.",
  "Notice boards and signs can be read. Click them.",
  "Middle-drag or use the arrow keys to turn the camera. The wheel zooms.",
  "Gear is where your strength comes from. Check your bag after every fight.",
];

const LAST_KEY = "levi.loading.last";

function pickLore(): Lore {
  let last = -1;
  try {
    last = Number(localStorage.getItem(LAST_KEY) ?? -1);
  } catch {
    // no memory: any page will do
  }
  let i = Math.floor(Math.random() * LORE.length);
  if (i === last) i = (i + 1) % LORE.length;
  try {
    localStorage.setItem(LAST_KEY, String(i));
  } catch {
    // not remembered
  }
  return LORE[i]!;
}

const root = document.getElementById("loading");
const fill = document.getElementById("ld-fill");
const status = document.getElementById("ld-status");
const tipText = document.getElementById("ld-tip");
let tipIndex = Math.floor(Math.random() * TIPS.length);
let tipTimer = 0;

if (root) {
  const lore = pickLore();
  const img = document.getElementById("ld-img") as HTMLImageElement | null;
  if (img) {
    img.onload = () => root.classList.add("art-ready");
    img.src = `/lore/${lore.image}.jpg`;
  }
  const title = document.getElementById("ld-title");
  const text = document.getElementById("ld-text");
  if (title) title.textContent = lore.title;
  if (text) text.textContent = lore.text;
  const showTip = (): void => {
    if (!tipText) return;
    tipText.classList.remove("in");
    void tipText.offsetWidth;
    tipText.textContent = TIPS[tipIndex % TIPS.length]!;
    tipText.classList.add("in");
    tipIndex++;
  };
  showTip();
  tipTimer = window.setInterval(showTip, 7000);
}

/**
 * Move the bar and say what's happening, then give the browser a moment to
 * paint it before the next (blocking) step runs.
 */
export function loadingStage(fraction: number, text?: string): Promise<void> {
  if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  if (text && status) status.textContent = text;
  return new Promise((resolve) => {
    const t = window.setTimeout(resolve, 60);
    requestAnimationFrame(() =>
      window.setTimeout(() => {
        window.clearTimeout(t);
        resolve();
      }, 0),
    );
  });
}

/** Just move the bar (no repaint wait): for progress that streams in. */
export function loadingProgress(fraction: number): void {
  if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
}

/** The world is ready: fade the page away. */
export function loadingDone(): void {
  if (!root) return;
  loadingProgress(1);
  if (status) status.textContent = "Welcome.";
  window.clearInterval(tipTimer);
  root.classList.add("done");
  window.setTimeout(() => root.remove(), 1300);
}

/** Boot failed: keep the page up and say so. */
export function loadingFailed(message: string): void {
  if (!root) return;
  window.clearInterval(tipTimer);
  root.classList.add("failed");
  if (status) status.textContent = `Something went wrong: ${message}`;
}
