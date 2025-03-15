import React, { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMetadata } from '../contexts/MetadataContext';

const TextDetailPage: React.FC = () => {
    const { textId } = useParams<{ textId: string }>();
    const { textsMetadata, authorsMetadata } = useMetadata();

    // Convert textId to number
    const numTextId = useMemo(() => parseInt(textId || '0', 10), [textId]);

    // Find the specific text
    const text = useMemo(() => {
        return textsMetadata.get(numTextId);
    }, [numTextId, textsMetadata]);

    // Find the author for this text
    const author = useMemo(() => {
        if (!text) return null;
        return authorsMetadata.get(text.au_id);
    }, [text, authorsMetadata]);

    // Find other texts by the same author
    const otherTextsByAuthor = useMemo(() => {
        if (!text) return [];
        return Array.from(textsMetadata.values())
            .filter(t => t.au_id === text.au_id && t.id !== text.id);
    }, [text, textsMetadata]);

    if (!text) {
        return (
            <div className="container mx-auto px-4 py-6">
                <div className="bg-white rounded-lg shadow-md p-6 text-center">
                    <p>Text not found</p>
                </div>
            </div>
        );
    }

    return (
        <div className="container mx-auto px-4 py-6 about">
            <div className="bg-white rounded-lg shadow-md p-6 ">
                <h1 className="text-3xl font-bold">{text.title}</h1>
                <h2 className="text-xl font-bold mb-4">{text.title_lat}</h2>

                <div className="gap-6">
                    <div>
                        <table className="w-full table-fixed text-left">
                            <colgroup>
                                <col className="w-[120px]" />
                            </colgroup>
                            <tbody>
                                <tr>
                                    <th className="py-2 border-b">Author</th>
                                    <td className="py-2 border-b">

                                        {author ? (
                                            <p>
                                                <p className='text-xl'>
                                                    {author.au_ar}
                                                </p>
                                                {author.au_lat} (d. {author.death_date && (
                                                    <>
                                                        {author.death_date}
                                                    </>
                                                )})

                                            </p>

                                        ) : (
                                            <p>Author information not available</p>
                                        )}

                                    </td>
                                </tr>

                                {/* Additional metadata fields from Excel */}
                                {Object.entries(text)
                                    .filter(([key]) =>
                                        !['id', 'title', 'title_lat', 'au_id', 'tags', 'volumes'].includes(key)
                                    )
                                    .map(([key, value]) => (
                                        <tr key={key}>
                                            <th className="py-2 border-b">{key}</th>
                                            <td className="py-2 border-b">{String(value)}</td>
                                        </tr>
                                    ))}
                                <tr>
                                    <th className="py-2 border-b">Genres</th>
                                    <td className="py-2 border-b">
                                        {text.tags?.join(', ') || 'No genres'}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                </div>

                {otherTextsByAuthor.length > 0 && (
                    <div className="mt-8">
                        <h2 className="text-xl font-semibold mb-4">
                            Other Texts by this Author
                        </h2>
                        <ul className="text-xl">
                            {otherTextsByAuthor.map(otherText => (
                                <li key={otherText.id}>
                                    <Link
                                        to={`/text/${otherText.id}`}
                                        className="text-gray-600 hover:underline"
                                    >
                                        {otherText.title}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </div >
    );
};

export default TextDetailPage;