import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./input.js";

const meta: Meta = {
  title: "Primitives/Input",
  component: "lens-input",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const TextInput: Story = {
  render: () => html`
    <div style="max-width: 300px;">
      <lens-input variant="text" placeholder="Enter value..."></lens-input>
    </div>
  `,
};

export const SearchInput: Story = {
  render: () => html`
    <div style="max-width: 300px;">
      <lens-input variant="search"></lens-input>
    </div>
  `,
};

export const TextareaInput: Story = {
  render: () => html`
    <div style="max-width: 300px;">
      <lens-input variant="textarea" placeholder="Type a message..."></lens-input>
    </div>
  `,
};

export const DisabledInput: Story = {
  render: () => html`
    <div style="max-width: 300px;">
      <lens-input variant="text" placeholder="Disabled" disabled></lens-input>
    </div>
  `,
};

export const AllVariants: Story = {
  render: () => html`
    <div style="display: flex; flex-direction: column; gap: 16px; max-width: 300px;">
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Text</div>
        <lens-input variant="text" placeholder="Enter value..."></lens-input>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Search</div>
        <lens-input variant="search"></lens-input>
      </div>
      <div>
        <div style="font-family: monospace; font-size: 10px; color: #484848; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Textarea</div>
        <lens-input variant="textarea" placeholder="Type a message..."></lens-input>
      </div>
    </div>
  `,
};
