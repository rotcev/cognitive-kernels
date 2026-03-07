import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./dashboard.js";
import { mockSnapshot } from "../mock/factories.js";

const meta: Meta = {
  title: "Compositions/FullDashboard",
  component: "lens-dashboard",
  parameters: { layout: "fullscreen" },
};
export default meta;

export const Default: StoryObj = {
  render: () => html`<lens-dashboard></lens-dashboard>`,
};

export const WithCustomSnapshot: StoryObj = {
  render: () => html`<lens-dashboard .snapshot=${mockSnapshot()}></lens-dashboard>`,
};
