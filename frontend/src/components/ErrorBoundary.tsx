import React from "react";

type Props = { children: React.ReactNode };
type State = { error: any };

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
  }
  render() {
    if (this.state.error) {
      return (
        <pre style={{ padding: 16, whiteSpace: "pre-wrap" }}>
          UI crash: {String(this.state.error)}
        </pre>
      );
    }
    return this.props.children as any;
  }
}

