import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./card.js";
import "./badge.js";

const meta: Meta = {
  title: "Primitives/Card",
  component: "lens-card",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <lens-card style="max-width: 500px;">
      <div style="font-size: 12px; color: #e0e0e0; line-height: 1.4;">
        Spawn architect before implementer to establish design constraints
      </div>
    </lens-card>
  `,
};

export const WithHeader: Story = {
  render: () => html`
    <lens-card style="max-width: 500px;">
      <div slot="header" style="display: flex; align-items: center; gap: 10px;">
        <span style="font-family: var(--lens-font-mono); font-size: 12px; font-weight: 600; color: #00ff88; background: rgba(0,255,136,0.15); padding: 2px 8px;">0.89</span>
        <span style="font-size: 12px; color: #e0e0e0;">Heuristic Card</span>
      </div>
      <div style="font-family: monospace; font-size: 10px; color: #484848; margin-top: 6px;">
        context: multi-module implementation &middot; scope: global &middot; reinforced: 3x
      </div>
    </lens-card>
  `,
};

export const HoverDemo: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 8px; max-width: 500px;">
      <lens-card>
        <div slot="header" style="font-family: monospace; font-size: 12px; font-weight: 500; color: #ffb020;">test-writer</div>
        <div style="font-family: monospace; font-size: 11px; color: #707070; margin-top: 4px;">
          blackboard_key_exists: auth.jwt_module_status
        </div>
        <div style="font-family: monospace; font-size: 11px; color: #484848; font-style: italic; margin-top: 4px;">
          Waiting for JWT module implementation to complete
        </div>
      </lens-card>
      <lens-card>
        <div slot="header" style="font-family: monospace; font-size: 12px; font-weight: 500; color: #ffb020;">validator</div>
        <div style="font-family: monospace; font-size: 11px; color: #707070; margin-top: 4px;">
          process_state: auth-middleware == dead
        </div>
        <div style="font-family: monospace; font-size: 11px; color: #484848; font-style: italic; margin-top: 4px;">
          Waiting for middleware implementation to finish
        </div>
      </lens-card>
    </div>
  `,
};
