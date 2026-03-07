import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./expanded-view.js";
import { mockProcesses } from "../mock/factories.js";

const meta: Meta = {
  title: "Domain/ExpandedView",
  component: "lens-expanded-view",
  parameters: { layout: "fullscreen" },
};
export default meta;

const process = mockProcesses()[0]; // metacog

export const Open: StoryObj = {
  render: () => html`
    <lens-expanded-view .process=${process} open></lens-expanded-view>
  `,
};

export const WithCheckpoint: StoryObj = {
  render: () => {
    const cp = mockProcesses()[3]; // jwt-handler with checkpoint
    return html`
      <lens-expanded-view .process=${cp} open></lens-expanded-view>
    `;
  },
};

export const DeadProcess: StoryObj = {
  render: () => {
    const dead = mockProcesses()[1]; // architect, dead
    return html`
      <lens-expanded-view .process=${dead} open></lens-expanded-view>
    `;
  },
};
