import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./connection-badge.js";

const meta: Meta = {
  title: "Domain/ConnectionBadge",
  component: "lens-connection-badge",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Connected: Story = {
  render: () => html`<lens-connection-badge status="connected"></lens-connection-badge>`,
};

export const Reconnecting: Story = {
  render: () => html`<lens-connection-badge status="reconnecting"></lens-connection-badge>`,
};

export const Disconnected: Story = {
  render: () => html`<lens-connection-badge status="disconnected"></lens-connection-badge>`,
};

export const AllStates: Story = {
  render: () => html`
    <div style="display: flex; gap: 16px; align-items: center;">
      <lens-connection-badge status="connected"></lens-connection-badge>
      <lens-connection-badge status="reconnecting"></lens-connection-badge>
      <lens-connection-badge status="disconnected"></lens-connection-badge>
    </div>
  `,
};
