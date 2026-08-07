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
    /// Takes a `Span<byte>`, and holds while a < b. Both of those break an XML
    /// parser, which is the whole reason this extension scans by hand.
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

    public void Use()
    {
        Untagged(default);
        Tagged(default);
        Mixed(default);
        NotDocumented();
        PastAnAttribute();
    }
}
