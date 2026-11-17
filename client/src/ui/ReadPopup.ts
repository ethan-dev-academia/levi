/**
 * Small framed note for reading signs, plaques and letters.
 * Text is set via textContent only (never parsed as HTML).
 */
export class ReadPopup {
  private readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly body: HTMLElement;

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "read-popup";
    this.root.hidden = true;
    this.title = document.createElement("h3");
    this.body = document.createElement("p");
    const close = document.createElement("button");
    close.className = "read-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    this.root.append(this.title, this.body, close);
    // Keep clicks on the note from reaching the game canvas.
    this.root.addEventListener("pointerdown", (e) => e.stopPropagation());
    host.appendChild(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(title: string, text: string): void {
    this.title.textContent = title;
    this.body.textContent = text.trim() || "It's blank.";
    this.root.hidden = false;
  }

  close(): void {
    this.root.hidden = true;
  }
}
