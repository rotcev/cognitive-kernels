import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./blackboard.js";
import { mockBlackboard } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/Blackboard",
  component: "lens-blackboard",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => {
    const bb = mockBlackboard();
    const firstKey = Object.keys(bb)[0];
    return html`
      <div style="height: 400px; width: 700px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
        <lens-blackboard .entries=${bb} selectedKey=${firstKey}></lens-blackboard>
      </div>
    `;
  },
};

export const NoneSelected: Story = {
  render: () => html`
    <div style="height: 400px; width: 700px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-blackboard .entries=${mockBlackboard()}></lens-blackboard>
    </div>
  `,
};
