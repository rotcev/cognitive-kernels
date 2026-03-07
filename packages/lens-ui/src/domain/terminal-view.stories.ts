import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./terminal-view.js";
import { mockTerminalLines } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/TerminalView",
  component: "lens-terminal-view",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <div style="height: 400px; width: 600px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-terminal-view .lines=${mockTerminalLines()}></lens-terminal-view>
    </div>
  `,
};

export const FilteredByProcess: Story = {
  render: () => html`
    <div style="height: 400px; width: 600px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-terminal-view .lines=${mockTerminalLines()} processFilter="proc-metacog-001"></lens-terminal-view>
    </div>
  `,
};

export const Empty: Story = {
  render: () => html`
    <div style="height: 400px; width: 600px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-terminal-view .lines=${[]}></lens-terminal-view>
    </div>
  `,
};
