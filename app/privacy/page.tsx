import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";

export const metadata = { title: "Privacy — Club Honbu" };

export default function Privacy() {
  return (
    <>
      <Nav />
      <main className="container-page py-24 md:py-32 max-w-3xl">
        <h1 className="text-4xl md:text-5xl font-semibold tracking-tight">Privacy</h1>
        <p className="mt-6 text-muted text-lg leading-relaxed">
          Placeholder privacy policy. The full policy will be published before public launch. Questions in the meantime: <a className="text-accent hover:underline" href="mailto:hello@clubhonbu.co.uk">hello@clubhonbu.co.uk</a>.
        </p>
      </main>
      <Footer />
    </>
  );
}
