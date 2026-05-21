export type ReasoningSplit =
  | { type: "content"; text: string }
  | { type: "reasoning"; text: string };

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

export class ThinkBlockSplitter {
  private mode: "content" | "reasoning" = "content";
  private buffer = "";

  push(text: string): ReasoningSplit[] {
    this.buffer += text;
    return this.drain(false);
  }

  flush(): ReasoningSplit[] {
    return this.drain(true);
  }

  private drain(flush: boolean): ReasoningSplit[] {
    const output: ReasoningSplit[] = [];
    while (this.buffer.length > 0) {
      if (this.mode === "content") {
        const open = this.buffer.indexOf(OPEN_TAG);
        if (open >= 0) {
          this.emit(output, "content", this.buffer.slice(0, open));
          this.buffer = this.buffer.slice(open + OPEN_TAG.length);
          this.mode = "reasoning";
          continue;
        }
        const keep = flush ? 0 : OPEN_TAG.length - 1;
        if (this.buffer.length <= keep) break;
        this.emit(output, "content", this.buffer.slice(0, this.buffer.length - keep));
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }

      const close = this.buffer.indexOf(CLOSE_TAG);
      if (close >= 0) {
        this.emit(output, "reasoning", this.buffer.slice(0, close));
        this.buffer = this.buffer.slice(close + CLOSE_TAG.length);
        this.mode = "content";
        continue;
      }
      const keep = flush ? 0 : CLOSE_TAG.length - 1;
      if (this.buffer.length <= keep) break;
      this.emit(output, "reasoning", this.buffer.slice(0, this.buffer.length - keep));
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      break;
    }

    if (flush && this.buffer.length > 0) {
      this.emit(output, this.mode, this.buffer);
      this.buffer = "";
    }
    return output;
  }

  private emit(output: ReasoningSplit[], type: ReasoningSplit["type"], text: string): void {
    if (text.length > 0) output.push({ type, text });
  }
}

export function estimateReasoningTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
