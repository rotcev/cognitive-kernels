import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./narrative-bar.js";

const meta: Meta = {
  title: "Domain/NarrativeBar",
  component: "lens-narrative-bar",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  render: () => html`
    <lens-narrative-bar
      text="metacog spawned architect to design authentication system"
    ></lens-narrative-bar>
  `,
};

export const LongText: Story = {
  render: () => html`
    <div style="width: 400px;">
      <lens-narrative-bar
        text="implementer spawned jwt-handler and auth-middleware to parallelize authentication module construction across two workers"
      ></lens-narrative-bar>
    </div>
  `,
};

export const Empty: Story = {
  render: () => html`<lens-narrative-bar></lens-narrative-bar>`,
};
