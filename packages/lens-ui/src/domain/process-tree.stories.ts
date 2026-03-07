import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./process-tree.js";
import { mockProcesses } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/ProcessTree",
  component: "lens-process-tree",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <div style="width: 480px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border); padding: 8px 0;">
      <lens-process-tree
        .processes=${mockProcesses()}
        selectedPid="proc-metacog-001"
      ></lens-process-tree>
    </div>
  `,
};

export const NoneSelected: Story = {
  render: () => html`
    <div style="width: 480px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border); padding: 8px 0;">
      <lens-process-tree .processes=${mockProcesses()}></lens-process-tree>
    </div>
  `,
};
