import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./badge.js";

const meta: Meta = {
  title: "Primitives/Badge",
  component: "lens-badge",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const StateBadges: Story = {
  render: () => html`
    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
      <lens-badge variant="state" state="running"></lens-badge>
      <lens-badge variant="state" state="sleeping"></lens-badge>
      <lens-badge variant="state" state="idle"></lens-badge>
      <lens-badge variant="state" state="dead"></lens-badge>
      <lens-badge variant="state" state="checkpoint"></lens-badge>
      <lens-badge variant="state" state="suspended"></lens-badge>
    </div>
  `,
};

export const RoleBadges: Story = {
  render: () => html`
    <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
      <lens-badge variant="role" role-type="kernel"></lens-badge>
      <lens-badge variant="role" role-type="sub-kernel"></lens-badge>
      <lens-badge variant="role" role-type="worker"></lens-badge>
      <lens-badge variant="role" role-type="shell"></lens-badge>
    </div>
  `,
};

export const AllBadges: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">State Badges</div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <lens-badge variant="state" state="running"></lens-badge>
          <lens-badge variant="state" state="sleeping"></lens-badge>
          <lens-badge variant="state" state="idle"></lens-badge>
          <lens-badge variant="state" state="dead"></lens-badge>
          <lens-badge variant="state" state="checkpoint"></lens-badge>
          <lens-badge variant="state" state="suspended"></lens-badge>
        </div>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Role Badges</div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <lens-badge variant="role" role-type="kernel"></lens-badge>
          <lens-badge variant="role" role-type="sub-kernel"></lens-badge>
          <lens-badge variant="role" role-type="worker"></lens-badge>
          <lens-badge variant="role" role-type="shell"></lens-badge>
        </div>
      </div>
    </div>
  `,
};
