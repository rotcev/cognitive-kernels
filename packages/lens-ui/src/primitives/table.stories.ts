import type { Meta, StoryObj } from "@storybook/web-components";
import { html } from "lit";
import "./table.js";

const meta: Meta = {
  title: "Primitives/Table",
  component: "lens-table",
  tags: ["autodocs"],
};
export default meta;

type Story = StoryObj;

export const BlackboardData: Story = {
  render: () => {
    const columns = [
      { key: "key", label: "Key" },
      { key: "value", label: "Value" },
      { key: "writer", label: "Writer" },
    ];
    const rows = [
      { key: "auth.architecture", value: '{ jwt_strategy: "RS256" }', writer: "architect" },
      { key: "auth.jwt_structure", value: '{ expiry: "15m" }', writer: "architect" },
      { key: "auth.middleware_plan", value: '{ layers: [...] }', writer: "architect" },
      { key: "auth.jwt_module_status", value: "implementation_complete", writer: "jwt-handler" },
      { key: "auth.token_schema", value: '{ accessToken: "string" }', writer: "jwt-handler" },
      { key: "auth.middleware_progress", value: "80%", writer: "auth-middleware" },
    ];
    return html`
      <div style="max-width: 600px;">
        <lens-table .columns=${columns} .rows=${rows}></lens-table>
      </div>
    `;
  },
};

export const ProcessTable: Story = {
  render: () => {
    const columns = [
      { key: "name", label: "Process" },
      { key: "state", label: "State" },
      { key: "tokens", label: "Tokens" },
      { key: "ticks", label: "Ticks" },
    ];
    const rows = [
      { name: "metacog", state: "running", tokens: "3,247", ticks: "42" },
      { name: "architect", state: "dead", tokens: "4,521", ticks: "15" },
      { name: "implementer", state: "running", tokens: "8,932", ticks: "28" },
      { name: "jwt-handler", state: "checkpoint", tokens: "5,200", ticks: "18" },
      { name: "auth-middleware", state: "running", tokens: "3,100", ticks: "12" },
      { name: "test-writer", state: "sleeping", tokens: "2,100", ticks: "8" },
    ];
    return html`
      <div style="max-width: 500px;">
        <lens-table .columns=${columns} .rows=${rows}></lens-table>
      </div>
    `;
  },
};
