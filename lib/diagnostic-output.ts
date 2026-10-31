export abstract class DiagnosticOutput {
  abstract write(line: string): Promise<void>
}
