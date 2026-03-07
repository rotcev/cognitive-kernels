import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./dag-view.js";
import { mockDagNodes, mockEdges } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/DagView",
  component: "lens-dag-view",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => {
    const el = document.createElement("lens-dag-view") as any;
    el.nodes = mockDagNodes();
    el.edges = mockEdges();
    el.style.height = "480px";
    el.style.border = "1px solid var(--lens-border)";
    return el;
  },
};

export const ShowDead: Story = {
  render: () => {
    const el = document.createElement("lens-dag-view") as any;
    el.nodes = mockDagNodes();
    el.edges = mockEdges();
    el.showDead = true;
    el.style.height = "480px";
    el.style.border = "1px solid var(--lens-border)";
    return el;
  },
};
