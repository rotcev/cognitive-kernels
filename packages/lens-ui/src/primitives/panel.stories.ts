import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./panel.js";

const meta: Meta = {
  title: "Primitives/Panel",
  component: "lens-panel",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const WithHeader: Story = {
  render: () => html`
    <lens-panel style="width: 300px;">
      <span slot="header">Process List</span>
      <div style="padding: 12px; font-family: monospace; font-size: 11px; color: #707070;">
        Panel content goes here
      </div>
    </lens-panel>
  `,
};

export const WithoutHeader: Story = {
  render: () => html`
    <lens-panel style="width: 300px;">
      <div style="padding: 12px; font-family: monospace; font-size: 11px; color: #707070;">
        Panel with no header, just content
      </div>
    </lens-panel>
  `,
};

export const NestedPanels: Story = {
  render: () => html`
    <lens-panel style="width: 400px;">
      <span slot="header">Outer Panel</span>
      <div style="padding: 12px;">
        <lens-panel>
          <span slot="header">Inner Panel</span>
          <div style="padding: 12px; font-family: monospace; font-size: 11px; color: #707070;">
            Nested content
          </div>
        </lens-panel>
      </div>
    </lens-panel>
  `,
};
