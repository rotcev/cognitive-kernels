import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./tooltip.js";

const meta: Meta = {
  title: "Primitives/Tooltip",
  component: "lens-tooltip",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const OpenTooltip: Story = {
  render: () => {
    const lines = [
      { label: "PID", value: "proc-metacog-001" },
      { label: "State", value: "running" },
      { label: "Tokens", value: "3,247 / 50,000" },
      { label: "Ticks", value: "42" },
      { label: "Model", value: "claude-sonnet-4" },
    ];
    return html`
      <div style="position: relative; height: 200px;">
        <lens-tooltip open .x=${20} .y=${20} .lines=${lines}></lens-tooltip>
      </div>
    `;
  },
};

export const BlackboardTooltip: Story = {
  render: () => {
    const lines = [
      { label: "Key", value: "auth.architecture" },
      { label: "Writer", value: "architect" },
      { label: "Read By", value: "implementer" },
      { label: "Type", value: "object" },
    ];
    return html`
      <div style="position: relative; height: 160px;">
        <lens-tooltip open .x=${20} .y=${20} .lines=${lines}></lens-tooltip>
      </div>
    `;
  },
};

export const ProcessTooltip: Story = {
  render: () => {
    const lines = [
      { label: "Process", value: "jwt-handler" },
      { label: "Role", value: "worker" },
      { label: "State", value: "checkpoint" },
      { label: "Reason", value: "Paused for test validation" },
      { label: "Saved At", value: "2m ago" },
    ];
    return html`
      <div style="position: relative; height: 180px;">
        <lens-tooltip open .x=${20} .y=${20} .lines=${lines}></lens-tooltip>
      </div>
    `;
  },
};
