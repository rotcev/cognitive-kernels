import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./button.js";

const meta: Meta = {
  title: "Primitives/Button",
  component: "lens-button",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const FilterButtons: Story = {
  render: () => html`
    <div style="display: flex; gap: 4px; align-items: center;">
      <lens-button variant="filter">All</lens-button>
      <lens-button variant="filter" active>Running</lens-button>
      <lens-button variant="filter">Workers</lens-button>
      <lens-button variant="filter" disabled>Disabled</lens-button>
    </div>
  `,
};

export const TabButtons: Story = {
  render: () => html`
    <div style="display: flex; gap: 0; border-bottom: 1px solid #1a1a1a;">
      <lens-button variant="tab" active>Topology</lens-button>
      <lens-button variant="tab">DAG</lens-button>
      <lens-button variant="tab">Blackboard</lens-button>
      <lens-button variant="tab">Heuristics</lens-button>
    </div>
  `,
};

export const ActionButton: Story = {
  render: () => html`
    <div style="display: flex; gap: 8px; align-items: center;">
      <lens-button variant="action">Send</lens-button>
      <lens-button variant="action" disabled>Disabled</lens-button>
    </div>
  `,
};

export const CloseButton: Story = {
  render: () => html`
    <div style="display: flex; gap: 8px; align-items: center;">
      <lens-button variant="close"></lens-button>
    </div>
  `,
};

export const AllVariants: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Filter</div>
        <div style="display: flex; gap: 4px;">
          <lens-button variant="filter">Inactive</lens-button>
          <lens-button variant="filter" active>Active</lens-button>
        </div>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Tab</div>
        <div style="display: flex; gap: 0; border-bottom: 1px solid #1a1a1a;">
          <lens-button variant="tab" active>Active Tab</lens-button>
          <lens-button variant="tab">Inactive Tab</lens-button>
        </div>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Action</div>
        <lens-button variant="action">Send Message</lens-button>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Close</div>
        <lens-button variant="close"></lens-button>
      </div>
    </div>
  `,
};
