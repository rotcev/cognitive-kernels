import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./metrics-bar.js";
import { mockMetrics } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/MetricsBar",
  component: "lens-metrics-bar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => {
    const el = document.createElement("lens-metrics-bar") as any;
    el.metrics = mockMetrics();
    return el;
  },
};
