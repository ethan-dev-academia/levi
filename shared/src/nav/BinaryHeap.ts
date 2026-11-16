/** Min-heap of integer node ids keyed by a float priority. */
export class BinaryHeap {
  private ids: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, key: number): void {
    this.ids.push(id);
    this.keys.push(key);
    this.up(this.ids.length - 1);
  }

  pop(): number | undefined {
    const n = this.ids.length;
    if (n === 0) return undefined;
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (n > 1) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      this.down(0);
    }
    return top;
  }

  private up(i: number): void {
    const { ids, keys } = this;
    const id = ids[i]!;
    const key = keys[i]!;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }

  private down(i: number): void {
    const { ids, keys } = this;
    const n = ids.length;
    const id = ids[i]!;
    const key = keys[i]!;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= n) break;
      const r = l + 1;
      const c = r < n && keys[r]! < keys[l]! ? r : l;
      if (keys[c]! >= key) break;
      ids[i] = ids[c]!;
      keys[i] = keys[c]!;
      i = c;
    }
    ids[i] = id;
    keys[i] = key;
  }
}
