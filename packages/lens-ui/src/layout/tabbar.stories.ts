import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./tabbar.js";

const meta: Meta = {
  title: "Layout/Tabbar",
  component: "lens-tabbar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

const centerTabs = [
  { id: "topology", label: "Topology" },
  { id: "dag", label: "DAG" },
  { id: "blackboard", label: "Blackboard" },
  { id: "heuristics", label: "Heuristics" },
  { id: "deferrals", label: "Deferrals" },
  { id: "terminal", label: "Terminal" },
];

const drawerTabs = [
  { id: "info", label: "Info" },
  { id: "terminal", label: "Terminal" },
  { id: "blackboard", label: "Blackboard" },
  { id: "messages", label: "Messages" },
];

export const CenterVariant: Story = {
  render: () => html`
    <lens-tabbar
      variant="center"
      .tabs=${centerTabs}
      activeTab="topology"
    ></lens-tabbar>
  `,
};

export const DrawerVariant: Story = {
  render: () => html`
    <lens-tabbar
      variant="drawer"
      .tabs=${drawerTabs}
      activeTab="info"
    ></lens-tabbar>
  `,
};
