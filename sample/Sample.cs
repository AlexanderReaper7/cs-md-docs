#pragma warning disable CA1822 // Mark members as static
// Scratch file for hovering in the Extension Development Host, and the fixture
// the integration test drives. The two sentinel sentences say which provider is
// supposed to render them, so a duplicate is visible by reading the hover.

namespace Sample;

public sealed class Device
{
    /// This sentence is untagged, so only cs-md-docs shows it.
    ///
    /// Two things matter here:
    ///
    /// - the `softwareId` at byte 3, which is how the reply is matched
    /// - **never** match a reply by arrival order
    ///
    /// Takes a `Span&lt;byte&gt;`, and holds while a < b. The entity is the spelling
    /// docs/agents.md tells you to use, because a raw `<` costs the member its whole
    /// entry in the generated XML file; the raw one beside it is here because this
    /// extension has to render both, which is why it scans by hand.
    public void Untagged(Span<byte> frame) { }

    /// <summary>This sentence is tagged, so only Roslyn shows it.</summary>
    /// <param name="frame">The report body.</param>
    public void Tagged(Span<byte> frame) { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    /// Mentions <see cref="M:Sample.Device.Tagged"/> and <c>List&lt;int&gt;</c>.
    /// <summary>This sentence is tagged, so only Roslyn shows it.</summary>
    /// <returns>Nothing useful.</returns>
    public void Mixed(Span<byte> frame) { }

    //// Four slashes is an ordinary comment, so nothing should appear.
    public void NotDocumented() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    [Obsolete("use Untagged")]
    public void PastAnAttribute() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    ///
    /// # Examples
    ///
    /// ```csharp
    /// var pressed = new List<int>();
    /// if (a < b) { dev.Send(frame); }
    /// /// <summary>Even a doc tag in here is sample code.</summary>
    /// ```
    ///
    /// > A blockquote survives, because `>` is not escaped.
    ///
    /// | byte | meaning |
    /// |---|---|
    /// | 3 | `softwareId` |
    public void RustShaped() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    ///
    /// > Two things matter:
    /// >
    /// > - the `softwareId` at byte 3
    /// > - never match a reply by arrival order
    ///
    /// <code>
    /// dev.Send(frame);
    /// </code>
    public void Grouped() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    ///
    /// All five, because each carries its own colour and its own codicon, and a
    /// sixth that is not an alert to any renderer and has to stay quoted prose.
    ///
    /// > [!NOTE]
    /// > A reply is matched by `softwareId`, never by arrival order.
    ///
    /// > [!TIP]
    /// > Prose written outside the tags renders as Markdown; prose inside a
    /// > `<summary>` is escaped by Roslyn and arrives as literal text.
    ///
    /// > [!IMPORTANT]
    /// > Write `&lt;`. A raw `<` costs the member its whole entry in the
    /// > generated XML file, `&lt;param&gt;` sections and all.
    ///
    /// > [!WARNING]
    /// > The Marketplace has no undo. A published version can only be superseded.
    ///
    /// > [!CAUTION]
    /// > Never set `isTrusted` to true: a doc comment is free to write a
    /// > `command:` link, and trust is what decides whether it runs.
    ///
    /// > [!TODO]
    /// > Not an alert to VS Code, so it stays an ordinary quote.
    public void Alerts() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    ///
    /// The indented multi-line form, which is what Visual Studio's snippet writes.
    /// Numbered, nested, and with the XML indentation discarded: five spaces after
    /// `1. ` would make the content an indented code block rather than an item.
    ///
    /// <list type="number">
    ///   <item>
    ///     <description>The value on the request.</description>
    ///   </item>
    ///   <item>
    ///     <description>The client default, which itself has
    ///       <list type="bullet">
    ///         <item>a per-endpoint override</item>
    ///         <item>a global one</item>
    ///       </list>
    ///     </description>
    ///   </item>
    /// </list>
    ///
    /// Prose after the list, which the list must not swallow.
    ///
    /// <list type="table">
    ///   <listheader><term>Code</term><description>Meaning</description></listheader>
    ///   <item><term>0x01</term><description>Busy</description></item>
    /// </list>
    ///
    /// <code language="xml">
    /// &lt;GenerateDocumentationFile&gt;true&lt;/GenerateDocumentationFile&gt;
    /// </code>
    public void Lists() { }

    /// This sentence is untagged, so only cs-md-docs shows it.
    /// Pairs with [`Device.Tagged`], and [the untagged one](Device.Untagged).
    /// An ordinary [note] and a [link](https://example.com/x) are left alone.
    public void Referencing() { }

    public void Use()
    {
        Untagged(default);
        Tagged(default);
        Mixed(default);
        NotDocumented();
        PastAnAttribute();
        RustShaped();
        Grouped();
        Alerts();
        Lists();
        Referencing();
    }
}
