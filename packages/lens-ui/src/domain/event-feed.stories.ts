import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./event-feed.js";
import { mockEvents } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/EventFeed",
  component: "lens-event-feed",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <div style="height: 400px; width: 480px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-event-feed .events=${mockEvents()} .activeFilters=${["tick", "spawn", "llm", "command", "exit", "checkpoint", "error"]}></lens-event-feed>
    </div>
  `,
};

export const FilteredSpawnOnly: Story = {
  render: () => html`
    <div style="height: 400px; width: 480px; background: var(--lens-bg-panel); border: 1px solid var(--lens-border);">
      <lens-event-feed .events=${mockEvents()} .activeFilters=${["spawn"]}></lens-event-feed>
    </div>
  `,
};
