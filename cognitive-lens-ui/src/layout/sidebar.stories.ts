import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./sidebar.js";
import { mockRuns } from "../mock/factories.js";

const meta: Meta = {
  title: "Layout/Sidebar",
  component: "lens-sidebar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const runs = mockRuns();

export const Default: Story = {
  render: () => html`
    <div style="height: 400px; width: 280px;">
      <lens-sidebar
        .runs=${runs}
        activeRunId=${runs[0].id}
        filter="All"
      ></lens-sidebar>
    </div>
  `,
};
