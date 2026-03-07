import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./heuristic-card.js";
import { mockHeuristics } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/HeuristicCard",
  component: "lens-heuristic-card",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const heuristics = mockHeuristics();

export const HighConfidence: Story = {
  render: () => {
    const el = document.createElement("lens-heuristic-card") as any;
    el.heuristic = heuristics[0];
    return el;
  },
};

export const MediumConfidence: Story = {
  render: () => {
    const el = document.createElement("lens-heuristic-card") as any;
    el.heuristic = heuristics[1];
    return el;
  },
};

export const LowConfidence: Story = {
  render: () => {
    const el = document.createElement("lens-heuristic-card") as any;
    el.heuristic = heuristics[2];
    return el;
  },
};

export const AllHeuristics: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 8px; max-width: 560px;">
      ${heuristics.map(h => {
        const el = document.createElement("lens-heuristic-card") as any;
        el.heuristic = h;
        return el;
      })}
    </div>
  `,
};
