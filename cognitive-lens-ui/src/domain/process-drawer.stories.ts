import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./process-drawer.js";
import { mockProcesses } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/ProcessDrawer",
  component: "lens-process-drawer",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const metacog = mockProcesses()[0];

export const Open: Story = {
  render: () => html`
    <div style="position: relative; width: 100%; height: 600px; background: var(--lens-bg-root);">
      <lens-process-drawer .process=${metacog} ?open=${true}></lens-process-drawer>
    </div>
  `,
};

export const SubKernel: Story = {
  render: () => html`
    <div style="position: relative; width: 100%; height: 600px; background: var(--lens-bg-root);">
      <lens-process-drawer .process=${mockProcesses()[2]} ?open=${true}></lens-process-drawer>
    </div>
  `,
};

export const Closed: Story = {
  render: () => html`
    <div style="position: relative; width: 100%; height: 600px; background: var(--lens-bg-root);">
      <lens-process-drawer .process=${metacog} ?open=${false}></lens-process-drawer>
    </div>
  `,
};
