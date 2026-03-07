import { LitElement, css, type CSSResultGroup } from "lit";

export const lensBaseStyles = css`
  :host {
    box-sizing: border-box;
    font-family: var(--lens-font-sans);
    font-size: 13px;
    line-height: 1.4;
    color: var(--lens-text);
    -webkit-font-smoothing: antialiased;
  }

  *, *::before, *::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  ::selection {
    background: var(--lens-accent-dim);
    color: var(--lens-accent);
  }

  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #222; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #333; }

  *:focus-visible {
    outline: 1px solid var(--lens-accent);
    outline-offset: 1px;
  }
`;

export class LensElement extends LitElement {
  static styles: CSSResultGroup = [lensBaseStyles];
}
