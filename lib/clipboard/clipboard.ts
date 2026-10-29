export abstract class Clipboard {
  abstract read(): Promise<string>
}
