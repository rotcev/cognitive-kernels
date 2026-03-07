import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./deferral-card.js";
import { mockDeferrals } from "../mock/factories.js";
import type { LensDeferral } from "../mock/types.js";

const meta: Meta = {
  title: "Domain/DeferralCard",
  component: "lens-deferral-card",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const deferrals = mockDeferrals();

const staleDeferral: LensDeferral = {
  id: "defer-stale",
  name: "integration-checker",
  conditionType: "blackboard_key_exists",
  conditionKey: "auth.middleware_complete",
  waitedTicks: 15,
  reason: "Waiting for middleware integration tests to pass before final assembly",
};

export const Normal: Story = {
  render: () => {
    const el = document.createElement("lens-deferral-card") as any;
    el.deferral = deferrals[0];
    return el;
  },
};

export const Stale: Story = {
  render: () => {
    const el = document.createElement("lens-deferral-card") as any;
    el.deferral = staleDeferral;
    return el;
  },
};

export const AllDeferrals: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 8px; max-width: 560px;">
      ${[deferrals[0], staleDeferral].map(d => {
        const el = document.createElement("lens-deferral-card") as any;
        el.deferral = d;
        return el;
      })}
    </div>
  `,
};
