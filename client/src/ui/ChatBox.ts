export type ChatKind = "game" | "system" | "player";

const MAX_LINES = 200;

/** Floating chat overlay; the input only appears while typing (Enter). */
export class ChatBox {
  constructor(
    private readonly log: HTMLElement,
    private readonly input: HTMLInputElement,
    onSubmit: (text: string) => void,
  ) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const text = input.value.trim();
        input.value = "";
        input.blur();
        if (text) onSubmit(text);
      } else if (e.key === "Escape") {
        input.value = "";
        input.blur();
      }
    });
    input.addEventListener("blur", () => input.classList.remove("active"));
  }

  focus(): void {
    this.input.classList.add("active");
    this.input.focus();
  }

  add(text: string, kind: ChatKind = "game"): void {
    const line = document.createElement("div");
    line.className = `msg-${kind}`;
    line.textContent = text; // never innerHTML: chat is untrusted
    this.log.appendChild(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild?.remove();
    this.log.scrollTop = this.log.scrollHeight;
  }
}
