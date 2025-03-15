import React from 'react';

const AboutPage: React.FC = () => {
  return (
    <div className="container mx-auto px-4 py-6 about">
      <div className="bg-white rounded-lg shadow-md p-6">
        <h1 className="text-3xl font-bold mb-6 text-center">About Kashshāf</h1>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">The Project</h2>
          <p className="mb-4">
            Kashshāf is a concordance that allows you to easily search a given term or phrase to see it's use in context. You can filter by author, time period, and genre. The concordance contains over 10,000 texts, the majority of which are medieval and early modern.
          </p>
          <p>
            The texts have been culled from the Open Islamicate Texts Initiative (<a href="https://openiti.org/" target="_blank" rel="noopener noreferrer">OITI</a>) and <a href='https://shamela.ws/' target="_blank" rel="noopener noreferrer">al-Maktaba al-Shāmila</a>. I have standardized them and did a significant amount of cleaning, but the corpus is still in its first iteration.
          </p>
        </section>
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Notes on Use:</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Search a word or phrase, and it will automatically include the following proclitics: ب، ف، و، ل، ك. e.g, if you search for التصوف it will include: بالتصوف، للتصوف، etc.</li>
            <li>Note that the search does not include BOTH definite and definite, e.g. if you search for التصوف it will not include تصوف</li>
            <li>Downloading search data will only include the first 5,000 results.</li>
          </ul>
        </section>
      </div>
    </div>
  );
};

export default AboutPage;