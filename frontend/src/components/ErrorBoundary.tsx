import React from "react";

type Props = { children: React.ReactNode };
type State = { error: any; info?: any };

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: any) {
    return { error };
  }
  componentDidCatch(error: any, info: any) {
    // Surfaced to console so it’s visible in production
    // without breaking the whole app.
    // eslint-disable-next-line no-console
    console.error("JOIN UI crash:", error, info);
    this.setState({ info });
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 16, whiteSpace: "pre-wrap" }}>
          UI crash: {String(this.state.error)}{"\n\n"}
          {this.state.info?.componentStack || "(no component stack)"}
          {"\n\n"}
          See https://react.dev/errors for details.
        </pre>
      );
    }
    return this.props.children as any;
  }
}
